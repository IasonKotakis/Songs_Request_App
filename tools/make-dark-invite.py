# Usage: python tools/make-dark-invite.py public/background.jpg public/background-dark.jpg
# Needs: pip install numpy scipy pillow. The corner clean-up below is specific to this invite.
# Makes a dark version of the invite: the beige paper becomes dark grey, everything else is kept.
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

src, dst = sys.argv[1], sys.argv[2]
DARK = np.array([30, 30, 32], float)          # page background in dark mode (#1e1e20)
a = np.asarray(Image.open(src).convert('RGB')).astype(float)
H, W, _ = a.shape
border = np.concatenate([a[:8].reshape(-1, 3), a[:, :8].reshape(-1, 3), a[:, -8:].reshape(-1, 3)])
paper = np.median(border, axis=0)

diff = np.abs(a - paper).max(axis=2)
warm = (a[..., 0] - a[..., 2]) > 7               # the paper is warm beige; white dots and faces are not
near = (diff < 22) & warm                      # paper-ish pixels (paper texture varies a little)

labels, n = ndimage.label(near)
sizes = ndimage.sum(np.ones_like(diff), labels, index=np.arange(1, n + 1))
means = np.array(ndimage.mean(a.reshape(-1, 3)[:, 0].reshape(H, W), labels, index=np.arange(1, n + 1)))
edge_ids = set(np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))) - {0}
is_paper = np.zeros(n + 1, bool)
for i in range(1, n + 1):
    if i in edge_ids:
        is_paper[i] = True                      # the open paper around everything
    elif sizes[i - 1] > 150:
        # enclosed paper, e.g. inside the letters A, R, P: must really be paper-coloured
        comp = a[labels == i]
        m = comp.mean(axis=0)
        is_paper[i] = np.abs(m - paper).max() < 7 and (m[0] - m[2]) > 9
mask = is_paper[labels]

# Specks in the paper texture: small non-paper islands fully inside paper become paper too.
holes, hn = ndimage.label(~mask)
hsizes = ndimage.sum(np.ones_like(diff), holes, index=np.arange(1, hn + 1))
small = np.zeros(hn + 1, bool); small[1:] = hsizes < 40
mask |= small[holes]

# Edge pixels where a shape blends into the paper look like a light fringe on dark grey:
# take light pixels within 3px of the paper as paper too.
lum = a.mean(axis=2)
ring = ndimage.binary_dilation(mask, iterations=3) & ~mask
mask |= ring & (lum > 150)

# The blue dot under the "29" was cut in half when the address strip was cropped off:
# drop its remains: in that corner, keep only the candle (red outline, cream fill, flame).
yy, xx = np.mgrid[0:H, 0:W]
box = ((xx < 168) & (yy > 1320)) | ((xx < 270) & (yy > 1385))   # left of and below the candle
warmth = a[..., 0] - a[..., 2]
candle = ((a[..., 0] > 140) & (warmth > 60)) | ((lum > 170) & (warmth > 20))
mask |= box & ~candle

soft = ndimage.gaussian_filter(mask.astype(float), 1.2)[..., None]
texture = np.clip((a - paper).mean(axis=2, keepdims=True) * 0.35, -4, 4)   # a hint of the paper grain, never patches
texture[box] = 0                                   # no ghost of the removed dot
dark_paper = np.clip(DARK + texture, 0, 255)
out = soft * dark_paper + (1 - soft) * a
Image.fromarray(out.round().astype(np.uint8)).save(dst, quality=82, optimize=True, progressive=True)
print('paper', paper, 'paper share', round(mask.mean(), 3))
