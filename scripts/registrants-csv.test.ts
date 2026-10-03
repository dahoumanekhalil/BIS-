import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AdminRole } from "@prisma/client";
import { csvCell, neutralizeFormula, toCsv } from "../lib/admin/csv";
import { can, PERMISSIONS, ROLE_PERMISSIONS } from "../lib/admin/rbac";

describe("neutralizeFormula", () => {
  test("prefixes cells a spreadsheet would run as a formula", () => {
    for (const v of [
      "=1+1",
      "=HYPERLINK(\"http://evil\",\"x\")",
      "+cmd|' /C calc'!A0",
      "-2+3+cmd|'/c calc'!A0",
      "@SUM(1,1)",
      "\t=1",
      "\r=1",
      " =1+1",
      " =1+1",
      "\u0001@SUM(1,1)",
      "+1\t=1"
    ]) {
      assert.equal(neutralizeFormula(v), `'${v}`, v);
    }
  });

  test("leaves normal text and phone numbers untouched", () => {
    for (const v of [
      "Amine Benali",
      "benali@example.com",
      "+213 555 12 34 56",
      "+213 (0) 555-12-34",
      "-5",
      "Société = Test",
      ""
    ]) {
      assert.equal(neutralizeFormula(v), v, v);
    }
  });
});

describe("csvCell / toCsv", () => {
  test("quotes commas, quotes and newlines (RFC 4180)", () => {
    assert.equal(csvCell("a,b"), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell("l1\nl2"), '"l1\nl2"');
  });

  test("null/undefined become empty, dates become ISO strings", () => {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
    assert.equal(
      csvCell(new Date("2026-10-03T20:14:00.000Z")),
      "2026-10-03T20:14:00.000Z"
    );
  });

  test("a hostile name is both neutralized and quoted", () => {
    assert.equal(csvCell('=HYPERLINK("x","y")'), `"'=HYPERLINK(""x"",""y"")"`);
  });

  test("toCsv adds a UTF-8 BOM and CRLF line endings", () => {
    const out = toCsv(["a", "b"], [["1", "é,ا"]]);
    assert.ok(out.startsWith("﻿"));
    assert.equal(out, '﻿a,b\r\n1,"é,ا"\r\n');
  });
});

describe("registrants.export.csv permission", () => {
  test("is a registered permission", () => {
    assert.ok(PERMISSIONS.includes("registrants.export.csv"));
  });

  test("is held by SUPER_ADMIN and by no other role", () => {
    assert.equal(can(AdminRole.SUPER_ADMIN, "registrants.export.csv"), true);
    for (const role of Object.values(AdminRole)) {
      if (role === AdminRole.SUPER_ADMIN) continue;
      assert.equal(
        ROLE_PERMISSIONS[role].includes("registrants.export.csv"),
        false,
        `${role} must not hold registrants.export.csv`
      );
    }
  });

  test("the legacy registrants.export is unchanged for other roles", () => {
    assert.equal(can(AdminRole.ADMIN, "registrants.export"), true);
    assert.equal(can(AdminRole.SALES, "registrants.export"), true);
  });
});
