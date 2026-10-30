import type { Format } from './types.js';
import * as pacman from './pacman.js';
import * as deb from './deb.js';
import * as rpm from './rpm.js';
import * as flatpak from './flatpak.js';

export type RepoType = 'pacman' | 'deb' | 'rpm' | 'flatpak';

export const formats: Record<RepoType, Format> = { pacman, deb, rpm, flatpak };
