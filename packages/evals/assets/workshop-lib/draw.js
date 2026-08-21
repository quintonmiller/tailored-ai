/*
 * Draw — canvas shapes worth more than a rectangle. Provided; you cannot edit
 * this file.
 *
 * The brief forbids image files, so everything is drawn from paths. That is not
 * a reason for a game to look like a wireframe: a circle with a radial gradient
 * and a highlight reads as a physical object, and it is four lines of canvas.
 * These are the four-line versions, so you can spend your rounds on what is on
 * screen rather than on how to put it there.
 *
 * Every function takes the 2d context first and leaves it as it found it.
 */
(function (global) {
  "use strict";

  function Draw(ctx) {
    return ctx;
  }

  Draw.rect = function (ctx, x, y, w, h, radius, fill, stroke) {
    var r = Math.min(radius || 0, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    ctx.restore();
  };

  /**
   * A sphere: radial gradient plus an off-centre highlight.
   *
   * This is the single highest-return call in the file. A flat `arc` + `fill`
   * disc and this one differ by about six lines and look like different games.
   */
  Draw.orb = function (ctx, x, y, radius, colour, highlight) {
    ctx.save();
    var g = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.4, radius * 0.1, x, y, radius);
    g.addColorStop(0, highlight || Draw.lighten(colour, 0.45));
    g.addColorStop(0.65, colour);
    g.addColorStop(1, Draw.darken(colour, 0.3));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  /** A glow behind something. Draw it before the thing itself. */
  Draw.glow = function (ctx, x, y, radius, colour) {
    ctx.save();
    var g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, colour);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  /** A regular polygon. sides=3 is a triangle, 5 a pentagon, and so on. */
  Draw.polygon = function (ctx, x, y, radius, sides, rotation, fill, stroke) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation || 0);
    ctx.beginPath();
    for (var i = 0; i < sides; i++) {
      var a = (i / sides) * Math.PI * 2 - Math.PI / 2;
      var px = Math.cos(a) * radius;
      var py = Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    ctx.restore();
  };

  Draw.star = function (ctx, x, y, outer, inner, points, rotation, fill) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation || 0);
    ctx.beginPath();
    for (var i = 0; i < points * 2; i++) {
      var r = i % 2 === 0 ? outer : inner;
      var a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      var px = Math.cos(a) * r;
      var py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.restore();
  };

  /**
   * Text with alignment that does not need measuring.
   * opts: { size, family, weight, align, baseline, colour, shadow }
   */
  Draw.text = function (ctx, str, x, y, opts) {
    var o = opts || {};
    ctx.save();
    ctx.font =
      (o.weight || "600") + " " + (o.size || 16) + "px " + (o.family || "system-ui, -apple-system, sans-serif");
    ctx.textAlign = o.align || "left";
    ctx.textBaseline = o.baseline || "alphabetic";
    if (o.shadow) {
      ctx.shadowColor = o.shadow;
      ctx.shadowBlur = o.size ? o.size / 3 : 6;
    }
    ctx.fillStyle = o.colour || "#fff";
    ctx.fillText(str, x, y);
    ctx.restore();
  };

  /** A meter. `value` is 0..1. Use it for health, heat, charge, time. */
  Draw.bar = function (ctx, x, y, w, h, value, fill, back) {
    var v = Math.max(0, Math.min(1, value));
    Draw.rect(ctx, x, y, w, h, h / 2, back || "rgba(255,255,255,0.15)");
    if (v > 0) Draw.rect(ctx, x, y, Math.max(h, w * v), h, h / 2, fill || "#7ee081");
  };

  /** A vertical background wash. Two colours beat one flat fill for free. */
  Draw.backdrop = function (ctx, w, h, top, bottom) {
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };

  // --- colour helpers -----------------------------------------------------
  // Accept "#rgb", "#rrggbb" or "rgb()/rgba()". Anything else comes back
  // unchanged rather than throwing: a colour helper must never be the reason a
  // frame fails to draw.

  function parse(colour) {
    if (typeof colour !== "string") return null;
    var c = colour.trim();
    if (c[0] === "#") {
      if (c.length === 4) {
        return [parseInt(c[1] + c[1], 16), parseInt(c[2] + c[2], 16), parseInt(c[3] + c[3], 16), 1];
      }
      if (c.length === 7) {
        return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
      }
      return null;
    }
    var m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(",").map(function (n) {
      return parseFloat(n);
    });
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }

  function clamp255(n) {
    return Math.max(0, Math.min(255, Math.round(n)));
  }

  Draw.lighten = function (colour, amount) {
    var p = parse(colour);
    if (!p) return colour;
    var t = amount || 0.2;
    return "rgba(" + clamp255(p[0] + (255 - p[0]) * t) + "," + clamp255(p[1] + (255 - p[1]) * t) + "," +
      clamp255(p[2] + (255 - p[2]) * t) + "," + p[3] + ")";
  };

  Draw.darken = function (colour, amount) {
    var p = parse(colour);
    if (!p) return colour;
    var t = 1 - (amount || 0.2);
    return "rgba(" + clamp255(p[0] * t) + "," + clamp255(p[1] * t) + "," + clamp255(p[2] * t) + "," + p[3] + ")";
  };

  Draw.alpha = function (colour, a) {
    var p = parse(colour);
    if (!p) return colour;
    return "rgba(" + clamp255(p[0]) + "," + clamp255(p[1]) + "," + clamp255(p[2]) + "," + a + ")";
  };

  global.Draw = Draw;
})(this);
