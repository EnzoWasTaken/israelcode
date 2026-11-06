// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { fl, hourGreeting, isFlavorEnabled, setFlavorEnabled } from "./flavor";

describe("flavor", () => {
  beforeEach(() => setFlavorEnabled(true));

  it("is on by default and picks the fun wording", () => {
    expect(isFlavorEnabled()).toBe(true);
    expect(fl("plain", "fun")).toBe("fun");
  });

  it("falls back to the plain wording when switched off, and remembers it", () => {
    setFlavorEnabled(false);
    expect(fl("plain", "fun")).toBe("plain");
    expect(localStorage.getItem("ic-flavor")).toBe("0");
    setFlavorEnabled(true);
    expect(localStorage.getItem("ic-flavor")).toBe("1");
  });

  it("greets by the hour, with Shabbat from Friday afternoon through Saturday", () => {
    expect(hourGreeting(8, 1)).toMatch(/Boker tov/);
    expect(hourGreeting(14, 1)).toMatch(/Tzohorayim/);
    expect(hourGreeting(20, 1)).toMatch(/Erev tov/);
    expect(hourGreeting(2, 1)).toMatch(/Laila tov/);
    expect(hourGreeting(17, 5)).toMatch(/Shabbat/);
    expect(hourGreeting(10, 6)).toMatch(/Shabbat/);
    expect(hourGreeting(10, 5)).not.toMatch(/Shabbat/);
    setFlavorEnabled(false);
    expect(hourGreeting(8, 1)).toBe("Good morning.");
  });
});
