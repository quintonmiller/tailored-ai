/*
 * Loop — a fixed-timestep game loop. Provided; you cannot edit this file.
 *
 * Every jam before this one hand-wrote a loop, and most of them wrote the naive
 * version: update by whatever `requestAnimationFrame` handed them. That ties
 * your physics to the monitor, so the same game is twice as fast on a 120Hz
 * screen and jitters whenever a frame is late.
 *
 * This runs your update at a constant rate and draws as often as the display
 * allows. `update(dt)` always receives the same `dt`. Interpolation is left out
 * on purpose: at 60Hz it is not worth the complexity for a game this size.
 */
(function (global) {
  "use strict";

  var STEP = 1 / 60;
  // Past this, catch-up is abandoned rather than attempted. A tab restored
  // after five minutes must not run five minutes of physics in one frame —
  // that reads as a freeze, and it is how a "hang" bug usually turns out to be
  // an accumulator with no ceiling.
  var MAX_FRAME = 0.25;

  var Loop = {
    running: false,
    /** Seconds since start, advanced only while running. */
    time: 0,
    /** Frames drawn in the last second. Useful in a debug HUD. */
    fps: 0,

    /**
     * Start the loop.
     *   Loop.start(function (dt) { ... }, function () { ... })
     * `update` gets a constant dt. `draw` takes nothing — read your own state.
     */
    start: function (update, draw) {
      if (this.running) return;
      this.running = true;
      var self = this;
      var accumulator = 0;
      var last = 0;
      var frames = 0;
      var fpsClock = 0;

      function frame(now) {
        if (!self.running) return;
        var seconds = now / 1000;
        var elapsed = last === 0 ? 0 : Math.min(seconds - last, MAX_FRAME);
        last = seconds;

        accumulator += elapsed;
        while (accumulator >= STEP) {
          accumulator -= STEP;
          self.time += STEP;
          if (update) update(STEP);
          // Edge state ("was this key pressed *this* step") is cleared after
          // the step that observed it, not per animation frame — otherwise a
          // press is missed whenever two steps run in one frame.
          if (global.Keys && global.Keys._endStep) global.Keys._endStep();
        }

        frames += 1;
        fpsClock += elapsed;
        if (fpsClock >= 1) {
          self.fps = Math.round(frames / fpsClock);
          frames = 0;
          fpsClock = 0;
        }

        if (draw) draw();
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    },

    stop: function () {
      this.running = false;
    },
  };

  global.Loop = Loop;
})(this);
