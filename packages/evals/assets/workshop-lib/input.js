/*
 * Keys — keyboard state. Provided; you cannot edit this file.
 *
 * Reading `keydown` directly gives you the OS auto-repeat, which is why a
 * hand-rolled "did the player just jump" check fires forty times while a key is
 * held. This separates the two questions that actually matter:
 *
 *   Keys.down("Space")     — is it held right now?
 *   Keys.pressed("Space")  — did it go down during THIS update step?
 *
 * Arrows and WASD are unified, so you never have to check both.
 */
(function (global) {
  "use strict";

  var held = Object.create(null);
  var edge = Object.create(null);

  // One name per direction, whichever key produced it.
  var ALIAS = {
    ArrowLeft: "Left",
    KeyA: "Left",
    ArrowRight: "Right",
    KeyD: "Right",
    ArrowUp: "Up",
    KeyW: "Up",
    ArrowDown: "Down",
    KeyS: "Down",
    Space: "Action",
    Enter: "Start",
    Escape: "Pause",
  };

  function names(code) {
    return ALIAS[code] ? [code, ALIAS[code]] : [code];
  }

  global.addEventListener("keydown", function (e) {
    // The browser scrolls the page on arrows and space. On a canvas game that
    // reads as the whole screen lurching when you jump.
    if (ALIAS[e.code]) e.preventDefault();
    if (e.repeat) return; // auto-repeat is not a new press
    var list = names(e.code);
    for (var i = 0; i < list.length; i++) {
      if (!held[list[i]]) edge[list[i]] = true;
      held[list[i]] = true;
    }
  });

  global.addEventListener("keyup", function (e) {
    var list = names(e.code);
    for (var i = 0; i < list.length; i++) held[list[i]] = false;
  });

  // A key held while the tab loses focus never sends its keyup, so the player
  // comes back still walking left forever.
  global.addEventListener("blur", function () {
    held = Object.create(null);
    edge = Object.create(null);
  });

  var Keys = {
    /** Is this key held? Accepts "Left"/"Right"/"Up"/"Down"/"Action"/"Start"/"Pause" or a raw code. */
    down: function (name) {
      return !!held[name];
    },

    /** Did it go down during this update step? True for exactly one step. */
    pressed: function (name) {
      return !!edge[name];
    },

    /** -1, 0 or 1. Both directions held reads as 0, which is what a player expects. */
    axisX: function () {
      return (held.Right ? 1 : 0) - (held.Left ? 1 : 0);
    },

    axisY: function () {
      return (held.Down ? 1 : 0) - (held.Up ? 1 : 0);
    },

    /** Any key at all — for "press anything to start". */
    any: function () {
      for (var k in edge) if (edge[k]) return true;
      return false;
    },

    /** Called by Loop after each update step. You should not need this. */
    _endStep: function () {
      edge = Object.create(null);
    },
  };

  global.Keys = Keys;
})(this);
