import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  fromEventLocalInput,
  parseSessionInput,
  slugifyTitle,
  toEventLocalInput
} from "../lib/admin/session-input";

const valid = {
  title: "  Le paradoxe du fondateur  ",
  summary: "",
  type: "KEYNOTE",
  category: "INNOVATION",
  startsAt: "2027-01-03T09:00",
  durationMin: "45",
  stage: "",
  spaceId: "",
  isHighlighted: true,
  order: "0",
  speakerIds: ["a", "b", "a"]
};

describe("event local time (Africa/Algiers, UTC+1)", () => {
  test("09:00 local is 08:00 UTC", () => {
    assert.equal(
      fromEventLocalInput("2027-01-03T09:00")?.toISOString(),
      "2027-01-03T08:00:00.000Z"
    );
  });

  test("round-trips through the datetime-local format", () => {
    for (const v of ["2027-01-03T09:00", "2027-06-15T23:30", "2027-12-31T00:00"]) {
      const d = fromEventLocalInput(v);
      assert.ok(d, v);
      assert.equal(toEventLocalInput(d!), v);
    }
  });

  test("rejects impossible or malformed dates", () => {
    for (const v of [
      "2027-02-31T10:00",
      "2027-13-01T10:00",
      "2027-01-03T25:00",
      "2027-01-03 09:00",
      "2027-01-03",
      "not a date",
      ""
    ]) {
      assert.equal(fromEventLocalInput(v), null, v);
    }
  });
});

describe("parseSessionInput", () => {
  test("accepts a valid payload and normalises it", () => {
    const r = parseSessionInput(valid);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.title, "Le paradoxe du fondateur");
    assert.equal(r.data.summary, null);
    assert.equal(r.data.stage, null);
    assert.equal(r.data.spaceId, null);
    assert.equal(r.data.durationMin, 45);
    assert.deepEqual(r.data.speakerIds, ["a", "b"]);
    assert.equal(r.data.startsAt.toISOString(), "2027-01-03T08:00:00.000Z");
  });

  test("rejects an empty title, bad enums and out-of-range numbers", () => {
    const r = parseSessionInput({
      ...valid,
      title: "   ",
      type: "NOPE",
      category: "NOPE",
      durationMin: "2",
      order: "-1"
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    for (const k of ["title", "type", "category", "durationMin", "order"]) {
      assert.ok(k in r.fieldErrors, `missing error for ${k}`);
    }
  });

  test("rejects non-numeric durations and an overflowing date", () => {
    const r = parseSessionInput({
      ...valid,
      durationMin: "abc",
      startsAt: "2027-02-31T10:00"
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok("durationMin" in r.fieldErrors);
    assert.ok("startsAt" in r.fieldErrors);
  });

  test("caps the number of speakers and the field lengths", () => {
    const tooMany = parseSessionInput({
      ...valid,
      speakerIds: Array.from({ length: 31 }, (_, i) => `s${i}`)
    });
    assert.equal(tooMany.ok, false);
    const longTitle = parseSessionInput({ ...valid, title: "x".repeat(201) });
    assert.equal(longTitle.ok, false);
  });
});

describe("slugifyTitle", () => {
  test("lowercases, strips accents and symbols", () => {
    assert.equal(slugifyTitle("Le paradoxe du Fondateur Africain !"), "le-paradoxe-du-fondateur-africain");
    assert.equal(slugifyTitle("Éthique & Impact"), "ethique-impact");
    assert.equal(slugifyTitle("???"), "");
  });
});
