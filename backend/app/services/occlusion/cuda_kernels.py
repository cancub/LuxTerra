"""
Compiled CUDA C++ Ray-Marching Kernel for GPU-accelerated terrain occlusion.
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
"""

_compiled_kernel = None


def get_compiled_raymarch_kernel():
    """
    Returns the lazily compiled CuPy RawKernel instance.
    """
    global _compiled_kernel
    if _compiled_kernel is None:
        import cupy as cp
        _compiled_kernel = cp.RawKernel(RAYMARCH_CUDA_SOURCE, "raymarch_terrain_kernel")
    return _compiled_kernel
