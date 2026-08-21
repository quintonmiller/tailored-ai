/*
 * FX — the difference between a game that works and one that feels good.
 * Provided; you cannot edit this file.
 *
 * Particles, screen shake, flashes, easing and a seeded random. None of it is
 * hard to write, and that is exactly why it never gets written: it is the work
 * that always loses to "make the collision correct first", and then the jam
 * ends. It is here so that the polish round has something to spend itself on.
 *
 * Call FX.update(dt) once per update step and FX.draw(ctx) once per frame,
 * after your world and before your HUD.
 */
(function (global) {
  "use strict";

  var particles = [];
  var shake = { amount: 0, decay: 1 };
  var flash = { colour: null, amount: 0, decay: 1 };

  // A hard ceiling, because an emitter inside a collision handler is how a
  // jam game ends up allocating ten thousand objects a second and dropping to
  // four frames. Oldest go first.
  var MAX_PARTICLES = 400;

  var FX = {
    /**
     * Throw particles from a point.
     * opts: { count, colour, speed, spread, life, size, gravity, drag, angle }
     */
    burst: function (x, y, opts) {
      var o = opts || {};
      var count = o.count || 12;
      var angle = o.angle === undefined ? null : o.angle;
      var spread = o.spread === undefined ? Math.PI * 2 : o.spread;
      for (var i = 0; i < count; i++) {
        var a = angle === null ? Math.random() * Math.PI * 2 : angle + (Math.random() - 0.5) * spread;
        var speed = (o.speed || 120) * (0.5 + Math.random() * 0.5);
        particles.push({
          x: x,
          y: y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          life: (o.life || 0.6) * (0.6 + Math.random() * 0.4),
          age: 0,
          size: o.size || 3,
          colour: o.colour || "#fff",
          gravity: o.gravity === undefined ? 0 : o.gravity,
          drag: o.drag === undefined ? 0.98 : o.drag,
        });
      }
      if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);
    },

    /** Shake the screen. 6-10 is a hit; 20 is a death. */
    shake: function (amount, decay) {
      shake.amount = Math.max(shake.amount, amount);
      shake.decay = decay || 4;
    },

    /** Wash the screen with a colour that fades. Good for damage and pickups. */
    flash: function (colour, amount, decay) {
      flash.colour = colour;
      flash.amount = Math.max(flash.amount, amount === undefined ? 0.5 : amount);
      flash.decay = decay || 3;
    },

    update: function (dt) {
      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i];
        p.age += dt;
        if (p.age >= p.life) {
          particles.splice(i, 1);
          continue;
        }
        p.vy += p.gravity * dt;
        p.vx *= p.drag;
        p.vy *= p.drag;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      if (shake.amount > 0) shake.amount = Math.max(0, shake.amount - shake.decay * shake.amount * dt - dt);
      if (flash.amount > 0) flash.amount = Math.max(0, flash.amount - flash.decay * dt);
    },

    /**
     * Wrap your world drawing in these two to get the shake:
     *   FX.begin(ctx); drawWorld(); FX.end(ctx);
     */
    begin: function (ctx) {
      ctx.save();
      if (shake.amount > 0) {
        ctx.translate((Math.random() - 0.5) * shake.amount, (Math.random() - 0.5) * shake.amount);
      }
    },

    end: function (ctx) {
      ctx.restore();
    },

    /** Particles and the flash. After the world, before the HUD. */
    draw: function (ctx) {
      ctx.save();
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        var t = 1 - p.age / p.life;
        ctx.globalAlpha = Math.max(0, t);
        ctx.fillStyle = p.colour;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * t, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      if (flash.amount > 0 && flash.colour) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, flash.amount);
        ctx.fillStyle = flash.colour;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
      }
    },

    /** Drop everything. Call it when a run restarts. */
    clear: function () {
      particles.length = 0;
      shake.amount = 0;
      flash.amount = 0;
    },

    count: function () {
      return particles.length;
    },
  };

  // --- easing -------------------------------------------------------------
  // All take t in 0..1 and return a shaped 0..1. `outBack` overshoots and
  // settles, which is what makes a panel arriving on screen look intentional.
  FX.ease = {
    linear: function (t) {
      return t;
    },
    inQuad: function (t) {
      return t * t;
    },
    outQuad: function (t) {
      return 1 - (1 - t) * (1 - t);
    },
    inOutQuad: function (t) {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    },
    outCubic: function (t) {
      return 1 - Math.pow(1 - t, 3);
    },
    outBack: function (t) {
      var c = 1.70158;
      return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
    },
    outElastic: function (t) {
      if (t === 0 || t === 1) return t;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    },
  };

  FX.lerp = function (a, b, t) {
    return a + (b - a) * t;
  };

  FX.clamp = function (n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  };

  /**
   * A seeded random, so a level you like is a level you can get back.
   *   var r = FX.rng(42); r() -> 0..1; r.range(1, 6); r.pick(list)
   */
  FX.rng = function (seed) {
    var s = (seed >>> 0) || 1;
    var next = function () {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.range = function (lo, hi) {
      return lo + next() * (hi - lo);
    };
    next.int = function (lo, hi) {
      return Math.floor(next.range(lo, hi + 1));
    };
    next.pick = function (list) {
      return list[Math.floor(next() * list.length)];
    };
    return next;
  };

  global.FX = FX;
})(this);
