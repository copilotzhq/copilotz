/**
 * The app's theme, as the web host applies it, for the toolkit's pieces that
 * draw from it rather than from its variables (the `Logo`). Outside the host
 * (a test, a View drawn on its own), the defaults.
 */
import { createContext } from "react";
import { DEFAULT_THEME, type Theme } from "./default.ts";

export const ThemeContext = createContext<Theme>(DEFAULT_THEME);
