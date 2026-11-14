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
    float* __restrict__ canopy_path_m,        // Output: cumulative 3D canopy path length in meters
    int H, int W,
    int patch_y_offset, int patch_x_offset,
    int patch_H, int patch_W,
    float step_dr, float step_dc,
    float tan_alpha,
    float step_dist,
    float step_3d_m,
    int max_steps,
    int is_rooftop,                           // 1 = rooftop, 0 = ground mount
    float ground_stand_height_m,              // e.g. 1.5m
    int include_tree_canopy,                  // 1 = raymarch DSM canopy, 0 = ignore canopy
    int top_of_canopy                         // 1 = start ground rays at max(z_base, z_dsm)
) {
    int px = blockDim.x * blockIdx.x + threadIdx.x;
    int py = blockDim.y * blockIdx.y + threadIdx.y;

    if (px >= patch_W || py >= patch_H) return;

    int r0 = patch_y_offset + py;
    int c0 = patch_x_offset + px;

    float z_dtm_0 = dtm[r0 * W + c0];
    float z_dsm_0 = dsm[r0 * W + c0];

    // Receiver origin altitude: rooftop array sits at max(z_dtm, z_dsm);
    // ground-mount sits at z_dtm + stand_height, or max(z_base, z_dsm) in visual top-of-canopy mode.
    float z_base = z_dtm_0 + ground_stand_height_m;
    float z0 = (is_rooftop != 0)
        ? fmaxf(z_dtm_0, z_dsm_0)
        : ((top_of_canopy != 0 && include_tree_canopy != 0) ? fmaxf(z_base, z_dsm_0) : z_base);

    unsigned char is_terrain_unshaded = 1;
    unsigned char is_canopy_unshaded = 1;
    float acc_canopy_path_m = 0.0f;

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

        float z_ray = z0 + ((float)s * step_dist) * tan_alpha;

        if (z_dtm_sampled > z_ray) {
            // Blocked by solid earth
            is_terrain_unshaded = 0;
            is_canopy_unshaded = 0;
            break;
        } else if (include_tree_canopy != 0) {
            // Bilinear sample DSM
            float z_dsm_00 = dsm[r0_i * W + c0_i];
            float z_dsm_01 = dsm[r0_i * W + c1_i];
            float z_dsm_10 = dsm[r1_i * W + c0_i];
            float z_dsm_11 = dsm[r1_i * W + c1_i];
            float z_dsm_top = (1.0f - dc) * z_dsm_00 + dc * z_dsm_01;
            float z_dsm_bot = (1.0f - dc) * z_dsm_10 + dc * z_dsm_11;
            float z_dsm_sampled = (1.0f - dr) * z_dsm_top + dr * z_dsm_bot;
            z_dsm_sampled = fmaxf(z_dtm_sampled, z_dsm_sampled);

            if (z_dsm_sampled > z_ray) {
                // Blocked by tree canopy or elevated structure
                is_canopy_unshaded = 0;
                acc_canopy_path_m += step_3d_m;
            }
        }
    }

    int out_idx = py * patch_W + px;
    terrain_mask[out_idx] = is_terrain_unshaded;
    canopy_mask[out_idx] = is_canopy_unshaded;
    if (canopy_path_m != 0) {
        canopy_path_m[out_idx] = acc_canopy_path_m;
    }
}

extern "C" __global__
void raymarch_ground_and_top_kernel(
    const float* __restrict__ dtm,
    const float* __restrict__ dsm,
    unsigned char* __restrict__ g_terrain_mask,
    unsigned char* __restrict__ g_canopy_mask,
    float* __restrict__ g_canopy_path_m,
    unsigned char* __restrict__ t_terrain_mask,
    unsigned char* __restrict__ t_canopy_mask,
    float* __restrict__ t_canopy_path_m,
    int H, int W,
    int patch_y_offset, int patch_x_offset,
    int patch_H, int patch_W,
    float step_dr, float step_dc,
    float tan_alpha,
    float step_dist,
    float step_3d_m,
    int max_steps,
    float ground_stand_height_m
) {
    int px = blockDim.x * blockIdx.x + threadIdx.x;
    int py = blockDim.y * blockIdx.y + threadIdx.y;

    if (px >= patch_W || py >= patch_H) return;

    int r0 = patch_y_offset + py;
    int c0 = patch_x_offset + px;

    float z_dtm_0 = dtm[r0 * W + c0];
    float z_dsm_0 = dsm[r0 * W + c0];

    float z_base = z_dtm_0 + ground_stand_height_m;
    float z_top = fmaxf(z_base, z_dsm_0);

    unsigned char g_t_unshaded = 1;
    unsigned char g_c_unshaded = 1;
    float g_acc_path = 0.0f;

    unsigned char t_t_unshaded = 1;
    unsigned char t_c_unshaded = 1;
    float t_acc_path = 0.0f;

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

        float z_dtm_00 = dtm[r0_i * W + c0_i];
        float z_dtm_01 = dtm[r0_i * W + c1_i];
        float z_dtm_10 = dtm[r1_i * W + c0_i];
        float z_dtm_11 = dtm[r1_i * W + c1_i];
        float z_dtm_top = (1.0f - dc) * z_dtm_00 + dc * z_dtm_01;
        float z_dtm_bot = (1.0f - dc) * z_dtm_10 + dc * z_dtm_11;
        float z_dtm_sampled = (1.0f - dr) * z_dtm_top + dr * z_dtm_bot;

        float step_rise = ((float)s * step_dist) * tan_alpha;
        float z_ray_g = z_base + step_rise;
        float z_ray_t = z_top + step_rise;

        if (z_dtm_sampled > z_ray_t) {
            t_t_unshaded = 0;
            t_c_unshaded = 0;
            g_t_unshaded = 0;
            g_c_unshaded = 0;
            break;
        }
        if (g_t_unshaded != 0 && z_dtm_sampled > z_ray_g) {
            g_t_unshaded = 0;
            g_c_unshaded = 0;
        }

        float z_dsm_00 = dsm[r0_i * W + c0_i];
        float z_dsm_01 = dsm[r0_i * W + c1_i];
        float z_dsm_10 = dsm[r1_i * W + c0_i];
        float z_dsm_11 = dsm[r1_i * W + c1_i];
        float z_dsm_top = (1.0f - dc) * z_dsm_00 + dc * z_dsm_01;
        float z_dsm_bot = (1.0f - dc) * z_dsm_10 + dc * z_dsm_11;
        float z_dsm_sampled = fmaxf(z_dtm_sampled, (1.0f - dr) * z_dsm_top + dr * z_dsm_bot);

        if (g_t_unshaded != 0 && z_dsm_sampled > z_ray_g) {
            g_c_unshaded = 0;
            g_acc_path += step_3d_m;
        }
        if (t_t_unshaded != 0 && z_dsm_sampled > z_ray_t) {
            t_c_unshaded = 0;
            t_acc_path += step_3d_m;
        }
    }

    int out_idx = py * patch_W + px;
    g_terrain_mask[out_idx] = g_t_unshaded;
    g_canopy_mask[out_idx] = g_c_unshaded;
    g_canopy_path_m[out_idx] = g_acc_path;
    t_terrain_mask[out_idx] = t_t_unshaded;
    t_canopy_mask[out_idx] = t_c_unshaded;
    t_canopy_path_m[out_idx] = t_acc_path;
}

extern "C" __global__
void compute_svf_kernel(
    const float* __restrict__ dtm,
    const float* __restrict__ dsm,
    float* __restrict__ svf_out,
    int H, int W,
    int patch_y_offset, int patch_x_offset,
    int patch_H, int patch_W,
    int num_azimuths,
    int max_steps,
    float step_dist,
    int is_rooftop,
    float ground_stand_height_m,
    int include_tree_canopy,
    float canopy_transmittance
) {
    int px = blockDim.x * blockIdx.x + threadIdx.x;
    int py = blockDim.y * blockIdx.y + threadIdx.y;

    if (px >= patch_W || py >= patch_H) return;

    int r0 = patch_y_offset + py;
    int c0 = patch_x_offset + px;

    float z_dtm_0 = dtm[r0 * W + c0];
    float z_dsm_0 = fmaxf(z_dtm_0, dsm[r0 * W + c0]);

    // Receiver altitude: rooftop sits atop DSM (+0.5m clearance), ground mount sits at DTM + stand height
    float z0 = (is_rooftop != 0 && include_tree_canopy != 0)
        ? (z_dsm_0 + 0.5f)
        : (z_dtm_0 + ground_stand_height_m);

    // Overhead canopy check if ground mount is directly under foliage
    float overhead_tan = 0.0f;
    if (include_tree_canopy != 0 && is_rooftop == 0 && z_dsm_0 > z0 + 0.5f) {
        overhead_tan = z_dsm_0 - z0;
    }

    float svf_sum = 0.0f;
    for (int a = 0; a < num_azimuths; ++a) {
        float phi = (2.0f * 3.14159265358979323846f * (float)a) / (float)num_azimuths;
        float step_dr = -cosf(phi);
        float step_dc = sinf(phi);

        float max_tan_dtm = 0.0f;
        float max_tan_dsm = overhead_tan;

        for (int s = 2; s <= max_steps; ++s) {
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

            float z_dtm_00 = dtm[r0_i * W + c0_i];
            float z_dtm_01 = dtm[r0_i * W + c1_i];
            float z_dtm_10 = dtm[r1_i * W + c0_i];
            float z_dtm_11 = dtm[r1_i * W + c1_i];
            float z_dtm_sampled = (1.0f - dr) * ((1.0f - dc) * z_dtm_00 + dc * z_dtm_01)
                                + dr * ((1.0f - dc) * z_dtm_10 + dc * z_dtm_11);

            float dist = (float)s * step_dist;
            float tan_t = (z_dtm_sampled - z0) / dist;
            if (tan_t > max_tan_dtm) {
                max_tan_dtm = tan_t;
            }
            if (tan_t > max_tan_dsm) {
                max_tan_dsm = tan_t;
            }

            if (include_tree_canopy != 0) {
                float z_dsm_00 = dsm[r0_i * W + c0_i];
                float z_dsm_01 = dsm[r0_i * W + c1_i];
                float z_dsm_10 = dsm[r1_i * W + c0_i];
                float z_dsm_11 = dsm[r1_i * W + c1_i];
                float z_dsm_sampled = (1.0f - dr) * ((1.0f - dc) * z_dsm_00 + dc * z_dsm_01)
                                    + dr * ((1.0f - dc) * z_dsm_10 + dc * z_dsm_11);
                z_dsm_sampled = fmaxf(z_dtm_sampled, z_dsm_sampled);

                float tan_s = (z_dsm_sampled - z0) / dist;
                if (tan_s > max_tan_dsm) {
                    max_tan_dsm = tan_s;
                }
            }
        }

        // Closed-form hemispherical integration: cos^2(atan(tan_gamma)) = 1 / (1 + tan_gamma^2)
        float svf_terrain = 1.0f / (1.0f + max_tan_dtm * max_tan_dtm);
        float svf_surface = 1.0f / (1.0f + max_tan_dsm * max_tan_dsm);

        // Opaque terrain blocks 100%; canopy above terrain horizon transmits canopy_transmittance
        float sector_svf = svf_surface + (svf_terrain - svf_surface) * canopy_transmittance;
        svf_sum += sector_svf;
    }

    svf_out[py * patch_W + px] = fminf(1.0f, fmaxf(0.05f, svf_sum / (float)num_azimuths));
}
"""

_compiled_terrain_kernel = None
_compiled_dual_kernel = None
_compiled_ground_and_top_kernel = None
_compiled_svf_kernel = None


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


def get_compiled_ground_and_top_kernel():
    """
    Returns the lazily compiled CuPy RawKernel instance for combined ground-level and top-of-canopy ray-marching.
    """
    global _compiled_ground_and_top_kernel
    if _compiled_ground_and_top_kernel is None:
        import cupy as cp
        _compiled_ground_and_top_kernel = cp.RawKernel(RAYMARCH_CUDA_SOURCE, "raymarch_ground_and_top_kernel")
    return _compiled_ground_and_top_kernel


def get_compiled_svf_kernel():
    """
    Returns the lazily compiled CuPy RawKernel instance for 360-degree Horizon Sky View Factor (SVF).
    """
    global _compiled_svf_kernel
    if _compiled_svf_kernel is None:
        import cupy as cp
        _compiled_svf_kernel = cp.RawKernel(RAYMARCH_CUDA_SOURCE, "compute_svf_kernel")
    return _compiled_svf_kernel
