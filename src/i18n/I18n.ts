import type { DecksSettings } from "../settings";
import {
  LOCALES,
  type LanguageCode,
  type LanguagePreference,
  type Translations,
} from "./locales";

export class I18n {
  private static current: Translations = LOCALES.en;
  private static currentCode: LanguageCode = "en";

  /**
   * @param settings - DecksSettings object
   * @param systemLanguage - BCP-47 language tag from the host platform
   *   (Obsidian: `getLanguage()`, mobile: `Localization.locale`)
   */
  static init(settings: DecksSettings, systemLanguage?: string): void {
    const pref: LanguagePreference = settings.i18n?.language ?? "auto";
    const resolved = pref === "auto" ? this.resolveFromSystem(systemLanguage) : pref;
    this.currentCode = resolved;
    this.current = LOCALES[resolved] ?? LOCALES.en;
  }

  private static resolveFromSystem(raw: string | undefined): LanguageCode {
    try {
      if (!raw) return "en";
      const base = raw.split("-")[0];
      return this.isSupported(base) ? base : "en";
    } catch {
      return "en";
    }
  }

  private static isSupported(code: string): code is LanguageCode {
    return Object.prototype.hasOwnProperty.call(LOCALES, code);
  }

  static get t(): Translations {
    return this.current;
  }

  static get code(): LanguageCode {
    return this.currentCode;
  }

  static format(
    template: string,
    params: Record<string, string | number>
  ): string {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = params[key];
      return value !== undefined ? String(value) : `{${key}}`;
    });
  }
}
