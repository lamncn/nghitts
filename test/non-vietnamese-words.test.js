import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const vietnameseWords = [
  "long", "nghe", "song", "the", "sung", "dao", "kia", "say", "hong",
  "sen", "leo", "son", "ham", "dan", "chen", "khao", "tom", "sun",
  "sim", "sam", "day", "don", "den", "seo", "choi", "tong", "lin",
  "hoe", "them", "bun", "hui", "ria", "dua", "peng", "seng",
  "mom", "cheng", "toe", "roe", "huyn", "meng", "rui", "poe",
  "choong",
];

test("Vietnamese words are not overridden by the foreign-word map", async () => {
  const csv = await readFile(
    new URL("../public/non-vietnamese-words.csv", import.meta.url),
    "utf8",
  );
  const originals = new Set(
    csv
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(",", 1)[0].trim().toLowerCase())
      .filter(Boolean),
  );

  for (const word of vietnameseWords) {
    assert.equal(originals.has(word), false, `${word} must remain Vietnamese`);
  }
});
