/**
 * Language-agnostic reference extraction tests (plan-v3 §0.1: the same
 * mechanism must hold on any language family). Each case is a tiny on-disk
 * fixture; assertion is on the resolved edges/cards importClosure proves
 * against the listing — never on a language-specific expectation baked into
 * the implementation.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractOutline, importClosure, type Card } from "../src/s0.js";

let root: string;

const mkCard = (rel: string): Card => ({
  id: "F1",
  abs: resolve(root, rel),
  rel,
  ext: extname(rel),
  size: 1,
  matches: [],
  terms: [],
  outline: [],
});

const listingOf = (files: string[]): Set<string> => new Set(files);

const targets = (res: { edges: { from: string; to: string }[] }): string[] =>
  res.edges.map((e) => e.to).sort();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dk-s0-closure-"));
  const w = async (rel: string, body: string): Promise<void> => {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  };
  // astro / svelte-family frontmatter (quoted relative refs + route literal)
  await w("src/components/Visit.astro", `---
import Card from "./Card.astro";
import { getData } from "../lib/db";
const data = await getData();
fetch("/api/visits");
---
<div><Card /></div>`);
  await w("src/components/Card.astro", "---\nconst x = 1;\n---\n<span>{x}</span>");
  await w("src/lib/db.ts", "export const getData = () => 1;\n");
  await w("src/pages/api/visits.ts", "export const handler = () => 0;\n");
  // python: bare dotted modules, relative dots, stdlib rejection
  await w("app/main.py", `from app.models.listing import Listing
import config
from .helpers.fmt import fmt
import os`);
  await w("app/models/listing.py", "class Listing:\n    pass\n");
  await w("config.py", "TTL = 60\n");
  await w("app/helpers/fmt.py", "def fmt(x):\n    return x\n");
  // php: PSR-4 namespace + quoted require
  await w("src/Main.php", `<?php
use App\\Models\\Listing;
require __DIR__ . '/helpers/util.php';
$c = new Listing();`);
  await w("src/Models/Listing.php", "<?php\nclass Listing {}\n");
  await w("src/helpers/util.php", "<?php\nfunction util() {}\n");
  // rust: mod sibling + crate alias
  await w("src/main.rs", "mod db;\nuse crate::models::user;\nfn main() {}\n");
  await w("src/db.rs", "pub fn open() {}\n");
  await w("src/models/user.rs", "pub struct User;\n");
  // go: quoted internal-package import (module-name-prefixed paths are
  // external and must NOT resolve)
  await w("cmd/main.go", `package main
import "app/internal/store"
func main() {}`);
  await w("app/internal/store.go", "package store\n");
  // kotlin: quoted? no — java/kt dotted import (bare)
  await w("src/Main.kt", `import com.example.core.User
fun main() {}`);
  await w("src/com/example/core/User.kt", "class User\n");
  // externals that must never become edges
  await w("src/external.ts", `import { useState } from "react";
import doc from "https://example.com/doc";
import { Button } from "@acme/ui";`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("importClosure — language-agnostic reference extraction", () => {
  it("astro frontmatter: quoted relative imports + route literal → repo files", async () => {
    const res = await importClosure(
      root,
      [mkCard("src/components/Visit.astro")],
      listingOf([
        "src/components/Visit.astro", "src/components/Card.astro", "src/lib/db.ts",
        "src/pages/api/visits.ts",
      ]),
    );
    expect(targets(res)).toEqual([
      "src/components/Card.astro",
      "src/lib/db.ts",
      "src/pages/api/visits.ts",
    ]);
    expect(res.cards.every((c) => c.widened === true)).toBe(true);
  });

  it("python: dotted + relative imports resolve; stdlib does not", async () => {
    const res = await importClosure(
      root,
      [mkCard("app/main.py")],
      listingOf([
        "app/main.py", "app/models/listing.py", "config.py", "app/helpers/fmt.py",
      ]),
    );
    expect(targets(res)).toEqual(["app/helpers/fmt.py", "app/models/listing.py", "config.py"]);
  });

  it("php: PSR-4 namespace + quoted require resolve", async () => {
    const res = await importClosure(
      root,
      [mkCard("src/Main.php")],
      listingOf(["src/Main.php", "src/Models/Listing.php", "src/helpers/util.php"]),
    );
    expect(targets(res)).toEqual(["src/Models/Listing.php", "src/helpers/util.php"]);
  });

  it("rust: mod sibling + crate:: alias resolve", async () => {
    const res = await importClosure(
      root,
      [mkCard("src/main.rs")],
      listingOf(["src/main.rs", "src/db.rs", "src/models/user.rs"]),
    );
    expect(targets(res)).toEqual(["src/db.rs", "src/models/user.rs"]);
  });

  it("go: internal package import resolves; module-prefixed import does not", async () => {
    const res = await importClosure(
      root,
      [mkCard("cmd/main.go")],
      listingOf(["cmd/main.go", "app/internal/store.go"]),
    );
    expect(targets(res)).toEqual(["app/internal/store.go"]);
  });

  it("kotlin: dotted import resolves by suffix", async () => {
    const res = await importClosure(
      root,
      [mkCard("src/Main.kt")],
      listingOf(["src/Main.kt", "src/com/example/core/User.kt"]),
    );
    expect(targets(res)).toEqual(["src/com/example/core/User.kt"]);
  });

  it("external packages, URLs, and npm scopes never become edges", async () => {
    const res = await importClosure(
      root,
      [mkCard("src/external.ts")],
      listingOf([
        "src/external.ts", "src/com/example/core/User.kt",
      ]),
    );
    expect(res.edges).toEqual([]);
    expect(res.cards).toEqual([]);
  });

  it("data files are not parsed as sources", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ deps: { x: "./src/lib/db.ts" } }));
    const res = await importClosure(
      root,
      [mkCard("package.json")],
      listingOf(["package.json", "src/lib/db.ts"]),
    );
    expect(res.edges).toEqual([]);
  });
});

describe("extractOutline — multi-family declarations", () => {
  it("php: functions and classes", async () => {
    const out = await extractOutline(join(root, "src/Models/Listing.php"), ".php");
    expect(out.some((l) => l.endsWith(" Listing"))).toBe(true);
  });
  it("python: def/class", async () => {
    const out = await extractOutline(join(root, "app/models/listing.py"), ".py");
    expect(out.some((l) => l.endsWith(" Listing"))).toBe(true);
  });
  it("kotlin: fun declarations", async () => {
    const out = await extractOutline(join(root, "src/Main.kt"), ".kt");
    expect(out.some((l) => l.endsWith(" main"))).toBe(true);
  });
  it("rust: pub fn", async () => {
    const out = await extractOutline(join(root, "src/db.rs"), ".rs");
    expect(out.some((l) => l.endsWith(" open"))).toBe(true);
  });
});
