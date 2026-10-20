---
"@tailored-ai/ui": patch
---

The 3D world lets go of a stage once it is taken down.

Every time you started a visit or went back to the agent's own view, the page
kept the whole stage it had just taken down: its scene, its canvas and WebGL
context, its figures, and some thirty canvas textures. Thirty trips round the
world that went back to the agent's view three times held seven old stages and
228 canvases, and the JS heap grew from 11 to 34 MB; nothing gave them back
until the tab closed.

The holders were things made once for the whole page and drawn by every stage:
three.js's lookup table for lit materials, the one square three.js draws every
sprite on, and the shapes and paints bodies wear. A renderer hangs a listener
on each thing it draws, and that listener holds the renderer, its canvas and so
the stage. These are now kept through `share()` (`avatar/shared.ts`), and a
stage going disposes them, so every renderer that drew them lets go; a stage
still drawing them uploads them again on its next frame. The stage's drawing
context is also released as it goes, and when a body's model fails to load,
rather than whenever the garbage collector gets to it. After the change the same thirty trips hold no old stage, nine
canvases (the live stage's), and the heap stays at about 16.5 MB from the tenth
trip on.
