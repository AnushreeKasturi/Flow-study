# Social preview lake

Generated with the built-in imagegen tool. The lettering is rendered separately
by `scripts/social-preview.html` so it stays crisp and editable.

## Generation prompt

Use case: ads-marketing.
Asset type: full-bleed photographic background for the Flow social preview. Wide 1200 x 630 landscape composition, aspect 1.905:1.
Primary request: A VERY BLURRY dreamy photograph of a quiet summer lake seen through windblown grasses and reeds, with pale blue water, an open blue sky and distant soft green banks. Change the scenery completely from an overhead tree canopy to a low lakeside view. Make the blur the dominant aesthetic.
Style: intentional camera movement photography, pronounced optical defocus combined with sweeping radial zoom blur across the ENTIRE scene. Atmospheric and cinematic, like a fleeting memory of a peaceful afternoon by the water. Every reed, every tree and every reflection is smeared into soft flowing strokes of color. NO SHARP SCENIC DETAIL ANYWHERE. No crisp leaves, grass blades, mountains, ripples or cloud edges. It must clearly read as a heavily blurred real photograph, not a painting or an illustration. Strong soft swishing blur throughout the image, beyond a little edge blur or shallow depth of field. Fine restrained film grain.
Composition: low distant horizon at about the upper third, wide expanse of luminous pale blue lake through the central area, green grassy banks reaching into the outer lower corners. A little warm afternoon sunlight, fresh soft blue, luminous sage and golden green. Center x=300..900 y=220..405 should remain spacious, light blue and low contrast, suitable for black centered lettering to be added separately. Balanced natural scene with more open sky and water than vegetation. No giant foreground objects.
Text: NO text, letters, logos, watermarks, borders or UI. Background ONLY.
Avoid: sharp scenic detail, clear subject, fine foliage, postcard landscape, crisp horizon line, centered sun disk, pastel gradient with no photographic origin, illustration, dark vignette. This image should look at least as blurred as a photograph deliberately shot wildly out of focus with strong camera motion.

## Refinement prompt

The current artwork was edited with the built-in imagegen tool using the initial
lake image as its reference. The initial version is preserved in
`output/social-preview-v2/` locally.

Use case: style-transfer.
Asset type: photographic background for the Flow social preview, wide 1200 x 630 landscape composition (1.905:1).
Input image: edit target, the current blurry lake background.
Requested edit: Reduce the existing blur by about 30 percent. This is a SMALL adjustment to the same scene, not a new landscape. Keep the dreamy soft-focus feeling and noticeable gentle radial motion, but make the lakeshore, grasses and water a little more recognizable.
Bring back soft contours in the distant tree-covered banks, a few suggestions of ripples in the blue water, and soft individual reed shapes at the lower corners. All these details must still be visibly softened. Keep foreground motion blur and a soft distant shoreline. Aim for a middle ground between an indistinct wash of color and a sharp landscape photograph. The central lake area stays calm, smooth and free of distracting texture for separately overlaid lettering.
Preserve: exact existing wide composition, horizon position, pale blue sky and lake, sage and golden-green banks, warm afternoon light, framing, and soft photographic treatment.
Text: absolutely no text, letters, logos or watermarks; background only.
Avoid: crisp highly detailed foliage, razor-sharp reeds, dramatic new objects, mountain peaks, a sun disk, changing the color grade, adding a vignette, sharpening halos.
