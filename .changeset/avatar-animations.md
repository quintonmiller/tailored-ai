---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
---

The Talk page's avatar plays real animation. `live.avatar.animations` lists glTF animation libraries (any humanoid rig: Rigify, Unreal mannequin, Mixamo), served by `GET /api/live/animations/:index`. Each clip is adapted to the avatar the first time it plays. Idles, talking, walking at the clip's own pace, sitting and folded arms come from the files; gestures without a clip take over the arm while they play; code-driven motion remains the fallback. The avatar's arms are fitted to its body so its hands no longer pass through a wide torso. The close-up re-frames when the avatar arrives somewhere and never looks through a wall or a shelf. A cue the model stops writing at the very end of a reply (`<look at="you`) is now finished rather than spoken.
