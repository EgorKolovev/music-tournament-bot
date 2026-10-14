import { commands } from './commands.ts';
import { draw } from './draw.ts';
import { events } from './events.ts';
import { final } from './final.ts';
import { intake } from './intake.ts';
import { leave } from './leave.ts';
import { match } from './match.ts';
import { registration } from './registration.ts';

// Основной стиль: все тексты для участников, по разделам.
export const base = { registration, intake, draw, match, final, commands, leave, events };
