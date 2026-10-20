/**
 * Finding the bones and clips in an animation library: which rig its names
 * belong to, and which clip plays each moment.
 */
import { describe, expect, it } from "vitest";
import { mapRig, plain, rolesFor } from "./clips";

describe("mapRig", () => {
  it("recognises a rig by its bone names, however the loader stripped them", () => {
    const rigify = ["DEF-hips", "DEF-spine001", "DEF-spine002", "DEF-spine003", "DEF-neck", "DEF-head"].concat(
      ["shoulder", "upper_arm", "forearm", "hand", "thigh", "shin", "foot"].flatMap((b) => [`DEF-${b}L`, `DEF-${b}R`]),
    );
    expect(mapRig(rigify)?.rig).toBe("rigify");
    const unreal = [
      "pelvis",
      "spine_01",
      "spine_02",
      "neck_01",
      "Head",
      "upperarm_l",
      "lowerarm_l",
      "hand_l",
      "thigh_l",
      "calf_l",
    ];
    expect(mapRig(unreal)?.rig).toBe("unreal");
    expect(mapRig(unreal)?.bones.rightUpperArm).toBe("upperarm_r");
  });

  it("finds no rig in a skeleton that names its bones some other way", () => {
    expect(mapRig(["Bone", "Bone001", "Bone002"])).toBeUndefined();
  });

  it("compares names without case or punctuation", () => {
    expect(plain("DEF-spine.001")).toBe(plain("DEF-spine001"));
    expect(plain("mixamorig:LeftArm")).toBe("mixamorigleftarm");
  });
});

describe("rolesFor", () => {
  const names = [
    "Idle_Loop",
    "Idle_Talking_Loop",
    "Idle_TalkingPhone_Loop",
    "Walk_Loop",
    "Walk_Carry_Loop",
    "Sprint_Loop",
    "Jog_Fwd_Loop",
    "Sitting_Idle_Loop",
    "Sitting_Talking_Loop",
    "Idle_FoldArms_Loop",
    "Idle_No_Loop",
    "Yes",
    "Dance_Loop",
    "Roll_RM",
  ];

  it("picks the clip that plays each moment by the usual names", () => {
    expect(rolesFor(names)).toEqual({
      idle: "Idle_Loop",
      talk: "Idle_Talking_Loop",
      walk: "Walk_Loop",
      run: "Jog_Fwd_Loop",
      sit: "Sitting_Idle_Loop",
      sitTalk: "Sitting_Talking_Loop",
      foldArms: "Idle_FoldArms_Loop",
      shake: "Idle_No_Loop",
      dance: "Dance_Loop",
    });
  });

  it("runs with a sprint when there is no jog, and has no run when there is neither", () => {
    expect(rolesFor(["Idle_Loop", "Walk_Loop", "Sprint_Loop"]).run).toBe("Sprint_Loop");
    expect(rolesFor(["Idle_Loop", "Walk_Loop", "Jog_Bwd_Loop"]).run).toBeUndefined();
  });

  it("finds the walks of other kinds and the gestures a library has, by the usual names", () => {
    const more = ["Idle_Loop", "Walk_Loop", "Walk_Formal_Loop", "Crouch_Fwd_Loop", "Crouch_Idle_Loop", "Waving"];
    expect(rolesFor([...more, "Clapping", "Cheering", "Bow", "Salute", "Laughing", "Bow_Shoot"])).toMatchObject({
      walk: "Walk_Loop",
      march: "Walk_Formal_Loop",
      sneak: "Crouch_Fwd_Loop",
      wave: "Waving",
      clap: "Clapping",
      cheer: "Cheering",
      bow: "Bow",
      salute: "Salute",
      laugh: "Laughing",
    });
    // An archer's bow is no bow to make.
    expect(rolesFor(["Idle_Loop", "Bow_Shoot"]).bow).toBeUndefined();
  });

  it("does not take a thumbs-up called Yes for a nod: the nod stays code-driven", () => {
    expect(rolesFor(names).nod).toBeUndefined();
  });

  it("skips root-motion clips, which move the body on their own: the stage walks it", () => {
    expect(rolesFor(["Idle_Loop", "Walk_Fwd_RM", "Dance_RM"])).toEqual({ idle: "Idle_Loop" });
  });
});
