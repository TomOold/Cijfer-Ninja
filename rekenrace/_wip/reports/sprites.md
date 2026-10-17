# Report: sprites (RR.Sprites)

## Summary
RR.Sprites is done as parts/sprites.js (about 1000 lines, plain IIFE, no DOM access at load) with a preview page. It has four side-view open-wheel karts with visible animal drivers, a 12x12 head portrait per hero, and 13 icons: 8 round postmark stamps, flag, trophy, lock, licence and the extra empty-stamp. The karts are Eef de Egel (dark spiky dome, pointed snout, orange kart), Sien de Eekhoorn (big curled C-tail, tufted ears, teal kart with a cone nose), Bram de Pad (wide flat head, big eye bumps, yellow/green kart) and Oeke de Uil (ear tufts, big yellow eyes, tail feathers, purple/pink kart). All art comes from compact string maps layered in code (driver, then chassis, then wheels) and is baked once into cached canvases per (id, frame, flip). No image files are used, and the 1px transparent PNG for unknown ids is generated at runtime. Frame 0 and 1 differ only in the wheel spokes (plus-shaped vs X-shaped) and a 1px downward bob of the driver. The shared 32-colour soft palette has no neon and no pure black; outlines are navy or dark brown. Kart body lightness (CIE L*) is 83 for Bram, 63 for Eef, 47 for Sien and 32 for Oeke, and the silhouettes also differ. I checked it all by looking at screenshots at 14x, 8x, 4x and in-game 3x, plus grayscale, colour-blind and silhouette views. A headless Playwright test (sprites-dev/test.cjs) passes, and so does a no-DOM Node load. It checks the API contract, junk ids and arguments, exact mirror on flip, nearest-neighbour scaling, on-palette crisp pixels, anchor and extents, caching, and spread of kart lightness.

## Deviations from BRIEF
(none)

## Limitations
- No ground shadow in the sprites; the Scene must draw its own.
- The kart box is tight (32x22, no padding): tails, ears and tufts touch the top row, so never clip it. Frame 1 drops the driver 1px.
- The art is right-facing only (flip mirrors the whole sprite, including the heads' facing direction). Heads and icons have no flip option.
- The wheel animation has only 2 frames, so it can alias if toggled faster than about 6 Hz.
- Stamps are filled paper-white (warm white) discs with a coloured ring, not transparent; on dark UI backgrounds they read as little stickers. The per-theme ring colours are decorative.
- Hero lightness separation is per kart body. The animals' own colours are similar in warmth (hedgehog and squirrel are both brown/orange); they are told apart by shape.
- The palette colour 'ice' (#def0f7) is not used by any sprite; it is reserved for scenery (snow and ice).
- Only Chromium was checked; the code uses only basic Canvas 2D (fillRect, drawImage, toDataURL).
- Consumers must set CSS image-rendering: pixelated on <img> elements made from the URLs. Scale is rounded to a whole number between 1 and 16 (fractional or invalid values become 1).

## Extra
SIZES: kart 32x22 (SIZES.kart also carries ax:16, ay:22), head 12x12, icon 20x20. All sizes are logical px; scale them by whole numbers.

ANCHOR: draw(ctx, heroId, x, y, {scale=1, frame=0, flip=false}). x,y is the bottom-centre ground point. The sprite's top-left is (round(x) - 16*scale, round(y) - 22*scale). x is the vertical line between pixel columns 15 and 16, and y is the first row just below the wheels (the wheels' last pixel row is y-1). Flip mirrors around the same x and is an exact mirror. frame is reduced to 0 or 1 (any integer works, e.g. a running counter). Scale is rounded to a whole number between 1 and 16. draw() sets imageSmoothingEnabled=false for the draw and restores it. drawHead and drawIcon (see EXTRAS) use CENTRE anchoring: top-left = (round(x) - w*scale/2, round(y) - h*scale/2).

HERO_IDS: ['egel','eekhoorn','pad','uil'] (same ids and order as RR.Heroes).

ICON_NAMES: stamp-tulips, stamp-windmill, stamp-beach, stamp-forest, stamp-canal, stamp-harbour, stamp-ice, stamp-hills, flag, trophy, lock, licence, empty-stamp. The stamp-<theme> names match RR.Tracks themes. Pictograms: tulip, windmill, scallop shell, pine, gabled canal house, anchor, snowflake, castle on a hill. empty-stamp is a dashed slate ring with no paper disc and no picture.

PALETTE keys (32, name:hex): navy #232c4a, brown #4b3028, slate #5d6a86, grey #98a3b6, silver #cdd5e0, white #fbf6e9 (warm paper white), cream #f2dfb8, sand #e5c487, tan #c4955a, bark #8b5a38, orange #e57f36, rust #ab4e22, apricot #f4b268, red #c2493d, brick #8f3b34, pink #e58aa3, blush #f6c3cf, yellow #efcc52, gold #bf8e26, teal #1f7a82, deepteal #174f5c, aqua #86d1c6, blue #4678bd, deepblue #2b4a84, sky #a8d5ee, ice #def0f7, purple #573b8a, plum #3f2d68, lilac #b7a0d8, green #5a9e48, fir #2c6338, lime #a6cc70. RR.Sprites.PALETTE is a frozen name->hex object; Scene and the UI can reuse it. RR.Sprites.GLYPHS maps the one-letter map characters to palette names: n navy, d brown, s slate, g grey, v silver, w white, c cream, a sand, t tan, k bark, o orange, r rust, p apricot, e red, m brick, i pink, h blush, y yellow, u gold, q teal, z deepteal, x aqua, b blue, f deepblue, j sky, l ice, P purple, M plum, L lilac, G green, F fir, J lime.

KART COLOURS (body, tub row, CIE L*): pad yellow #efcc52 L83; egel orange #e57f36 L63; eekhoorn teal #1f7a82 L47; uil purple #573b8a L32.

EXTRAS beyond the BRIEF contract (all additive): drawHead(ctx, heroId, x, y, {scale}) and drawIcon(ctx, name, x, y, {scale}) draw straight onto a canvas, centre-anchored, which is handy for the minimap strip without Image loading. RR.Sprites.GLYPHS and SIZES.kart.ax/ay are exported. RR.Sprites.validate() returns [] when the art data is clean (row widths, glyphs, slots, wheels); it runs under plain Node and could be used in a test.

BEHAVIOUR: heroURL(id, scale) is the frame-0, unflipped kart at scale (default 1). headURL and iconURL are likewise. Everything is cached (kart canvases per id/frame/flip, plus head, icon and URL caches), and no canvas is created after warm-up. Unknown, junk or non-string ids (including 'constructor' and '__proto__') draw nothing and return a real 1x1 transparent PNG data URL (made at runtime; 'data:,' under Node), and nothing throws. Loading the file with no document (Node) is harmless. The module only assigns RR.Sprites, does not declare const RR, and uses no globals except document, lazily.

PREVIEW: open preview/sprites.html (it only needs the inline 'var RR = {};' bootstrap and sprites.js). Sections come from the URL hash: #karts (scales 1, 4, 8 on light and mid, frame 0 and 1, flipped), #small (1-4x on light, mid and road backgrounds), #situ (a 320x144 canvas CSS-scaled 3x), #heads (1, 2, 3, 4, 8, 12), #icons (1, 4, 8), #icons8 (a grid at 8x), #cb (normal, silhouette, grayscale, deuteranopia, protanopia, tritanopia), #palette, #focus=egel (or eekhoorn, pad, uil) for a 14x zoom, and no hash for everything. ART validation problems appear as console errors. Screenshot recipe: NODE_PATH=$(npm root -g) node scratchpad/tools/shot.cjs file:///<scratchpad>/preview/sprites.html#karts out.png 1000 800 (or the wrapper scratchpad/sprites-dev/shot.sh <section> <outname> [w] [h], which writes into preview/).

TESTS: NODE_PATH=$(npm root -g) node /tmp/claude-0/-home-user-Cijfer-Ninja/00d1ad9b-1373-5505-a589-45c7888ab89a/scratchpad/sprites-dev/test.cjs prints diagnostics and 'ALL OK' (it expects 0 failures). The only item flagged is the unused 'ice' colour, as intended.