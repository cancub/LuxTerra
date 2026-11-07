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

        int r = (int)(r_f >= 0.0f ? r_f + 0.5f : r_f - 0.5f);
        int c = (int)(c_f >= 0.0f ? c_f + 0.5f : c_f - 0.5f);

        if (r < 0 || r >= H || c < 0 || c >= W) {
            break; // Ray traveled outside buffered grid
        }

        float z_ray = z0 + ((float)s * step_dist) * tan_alpha;
        float z_terrain = elevation[r * W + c];

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
