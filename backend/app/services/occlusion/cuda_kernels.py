"""
Compiled CUDA C++ Ray-Marching Kernels for GPU-accelerated terrain and canopy occlusion.
"""

RAYMARCH_CUDA_SOURCE = r"""
extern "C" __global__
void raymarch_terrain_kernel(
    const float* __restrict__ elevation,    // Full buffered grid: (H, W)
    unsigned char* __restrict__ mask,       // Output patch mask: (patch_H, patch_W)
    int H, int W,
    int patch_y_offset, int patch_x_offset,
    int patch_H, int patch_W,
    float step_dr, float step_dc,
    float tan_alpha,
    float step_dist,
    int max_steps
) {
    int px = blockDim.x * blockIdx.x + threadIdx.x;
    int py = blockDim.y * blockIdx.y + threadIdx.y;

    if (px >= patch_W || py >= patch_H) return;

    int r0 = patch_y_offset + py;
    int c0 = patch_x_offset + px;

    float z0 = elevation[r0 * W + c0];
    unsigned char is_unshaded = 1;

    for (int s = 1; s <= max_steps; ++s) {
        float r_f = (float)r0 + (float)s * step_dr;
        float c_f = (float)c0 + (float)s * step_dc;

        if (r_f < 0.0f || r_f >= (float)(H - 1) || c_f < 0.0f || c_f >= (float)(W - 1)) {
            break; // Ray traveled outside buffered grid
        }

        int r0_i = (int)floorf(r_f);
        int c0_i = (int)floorf(c_f);
        int r1_i = r0_i + 1;
        int c1_i = c0_i + 1;

        float dr = r_f - (float)r0_i;
        float dc = c_f - (float)c0_i;

        float z00 = elevation[r0_i * W + c0_i];
        float z01 = elevation[r0_i * W + c1_i];
        float z10 = elevation[r1_i * W + c0_i];
        float z11 = elevation[r1_i * W + c1_i];

        float z_top = (1.0f - dc) * z00 + dc * z01;
        float z_bottom = (1.0f - dc) * z10 + dc * z11;
        float z_terrain = (1.0f - dr) * z_top + dr * z_bottom;

        float z_ray = z0 + ((float)s * step_dist) * tan_alpha;

        if (z_terrain > z_ray) {
            is_unshaded = 0; // Occluded by terrain
            break;
        }
    }

    mask[py * patch_W + px] = is_unshaded;
}

extern "C" __global__
void raymarch_dual_surface_kernel(
    const float* __restrict__ dtm,            // Bare terrain elevation: (H, W)
    const float* __restrict__ dsm,            // Surface elevation (canopy + structures): (H, W)
    unsigned char* __restrict__ terrain_mask, // Output: 1 = unshaded, 0 = terrain shaded (patch_H, patch_W)
    unsigned char* __restrict__ canopy_mask,  // Output: 1 = unshaded, 0 = canopy shaded (patch_H, patch_W)
    int H, int W,
    int patch_y_offset, int patch_x_offset,
    int patch_H, int patch_W,
    float step_dr, float step_dc,
    float tan_alpha,
    float step_dist,
    int max_steps,
    int is_rooftop,                           // 1 = rooftop, 0 = ground mount
    float ground_stand_height_m               // e.g. 1.5m
) {
    int px = blockDim.x * blockIdx.x + threadIdx.x;
    int py = blockDim.y * blockIdx.y + threadIdx.y;

    if (px >= patch_W || py >= patch_H) return;

    int r0 = patch_y_offset + py;
    int c0 = patch_x_offset + px;

    float z_dtm_0 = dtm[r0 * W + c0];
    float z_dsm_0 = dsm[r0 * W + c0];

    // Receiver origin altitude: rooftop array sits at z_dsm, ground array sits at z_dtm + stand_height
    float z0 = (is_rooftop != 0) ? fmaxf(z_dtm_0, z_dsm_0) : (z_dtm_0 + ground_stand_height_m);

    unsigned char is_terrain_unshaded = 1;
    unsigned char is_canopy_unshaded = 1;

    for (int s = 1; s <= max_steps; ++s) {
        float r_f = (float)r0 + (float)s * step_dr;
        float c_f = (float)c0 + (float)s * step_dc;

        if (r_f < 0.0f || r_f >= (float)(H - 1) || c_f < 0.0f || c_f >= (float)(W - 1)) {
            break;
        }

        int r0_i = (int)floorf(r_f);
        int c0_i = (int)floorf(c_f);
        int r1_i = r0_i + 1;
        int c1_i = c0_i + 1;

        float dr = r_f - (float)r0_i;
        float dc = c_f - (float)c0_i;

        // Bilinear sample DTM
        float z_dtm_00 = dtm[r0_i * W + c0_i];
        float z_dtm_01 = dtm[r0_i * W + c1_i];
        float z_dtm_10 = dtm[r1_i * W + c0_i];
        float z_dtm_11 = dtm[r1_i * W + c1_i];
        float z_dtm_top = (1.0f - dc) * z_dtm_00 + dc * z_dtm_01;
        float z_dtm_bot = (1.0f - dc) * z_dtm_10 + dc * z_dtm_11;
        float z_dtm_sampled = (1.0f - dr) * z_dtm_top + dr * z_dtm_bot;

        // Bilinear sample DSM
        float z_dsm_00 = dsm[r0_i * W + c0_i];
        float z_dsm_01 = dsm[r0_i * W + c1_i];
        float z_dsm_10 = dsm[r1_i * W + c0_i];
        float z_dsm_11 = dsm[r1_i * W + c1_i];
        float z_dsm_top = (1.0f - dc) * z_dsm_00 + dc * z_dsm_01;
        float z_dsm_bot = (1.0f - dc) * z_dsm_10 + dc * z_dsm_11;
        float z_dsm_sampled = (1.0f - dr) * z_dsm_top + dr * z_dsm_bot;

        z_dsm_sampled = fmaxf(z_dtm_sampled, z_dsm_sampled);

        float z_ray = z0 + ((float)s * step_dist) * tan_alpha;

        if (z_dtm_sampled > z_ray) {
            // Blocked by solid earth
            is_terrain_unshaded = 0;
            is_canopy_unshaded = 0;
            break;
        } else if (z_dsm_sampled > z_ray) {
            // Blocked by tree canopy or elevated structure
            is_canopy_unshaded = 0;
        }
    }

    int out_idx = py * patch_W + px;
    terrain_mask[out_idx] = is_terrain_unshaded;
    canopy_mask[out_idx] = is_canopy_unshaded;
}
"""

_compiled_terrain_kernel = None
_compiled_dual_kernel = None


def get_compiled_raymarch_kernel():
    """
    Returns the lazily compiled CuPy RawKernel instance for terrain ray-marching.
    """
    global _compiled_terrain_kernel
    if _compiled_terrain_kernel is None:
        import cupy as cp
        _compiled_terrain_kernel = cp.RawKernel(RAYMARCH_CUDA_SOURCE, "raymarch_terrain_kernel")
    return _compiled_terrain_kernel


def get_compiled_dual_raymarch_kernel():
    """
    Returns the lazily compiled CuPy RawKernel instance for dual-surface (DTM + DSM) ray-marching.
    """
    global _compiled_dual_kernel
    if _compiled_dual_kernel is None:
        import cupy as cp
        _compiled_dual_kernel = cp.RawKernel(RAYMARCH_CUDA_SOURCE, "raymarch_dual_surface_kernel")
    return _compiled_dual_kernel
