"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

// Class-based theming, defaulting to the OS preference. disableTransitionOnChange
// avoids a color-transition flash when switching themes.
export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
