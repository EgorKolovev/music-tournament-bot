// Несколько равноценных вариантов одной фразы. Бот берёт один — по тому, кому он пишет,
// и по содержимому сообщения: перерисовка того же сообщения даёт ту же фразу.
export interface Variants<P, F extends boolean = boolean> {
  readonly variants: readonly (string | ((p: P) => string))[];
  // Фраза с параметрами: в коде вызывается как функция, вариант выбирается и по параметрам.
  readonly params: F;
}

// Варианты фразы без параметров: в коде это строка.
export function pick(...variants: string[]): Variants<Record<string, never>, false> {
  return { variants, params: false };
}

// Варианты фразы с параметрами: в коде это функция.
export function pickWith<P>(...variants: (string | ((p: P) => string))[]): Variants<P, true> {
  return { variants, params: true };
}
