// The Fujifilm film looks: community look tables (github.com/abpy/FujifilmCameraProfiles,
// CC BY-NC-SA 4.0) that are not part of immich-raw. They are downloaded from the pinned commit
// only after asking, then kept in the browser (IndexedDB, next to the AI models).
import { cacheGet, cachePut } from '@immich-raw/ai/cache';
import {
  FUJI_FILES,
  FUJI_LOOKS_SOURCE,
  fujiLooksUrl,
  fujiProfileLooks,
  parseFujiLooks,
  validFujiLooksData,
  type FujiLooksData,
  type ProfileLooks,
} from '@immich-raw/pipeline';

const CONSENT_KEY = 'raw-editor.fujiLooks';
const CACHE_KEY = `fuji-looks:${FUJI_LOOKS_SOURCE.commit}:v1`;

export const FUJI_DECLINED = 'The Fujifilm film looks were not downloaded.';

/** 'yes': download without asking (e.g. for an album export); 'never': don't offer on open. */
export type FujiConsent = 'yes' | 'never' | 'ask';

function dataBytes(d: FujiLooksData): number {
  let n = 0;
  for (const t of Object.values(d.tables)) n += t.look.data.byteLength + t.curve.byteLength;
  for (const c of Object.values(d.cubes)) n += c.data.byteLength;
  return n;
}

class FujiLooks {
  status = $state<'unknown' | 'absent' | 'downloading' | 'ready' | 'error'>('unknown');
  /** Download progress, 0..1. */
  progress = $state(0);
  error = $state<string | null>(null);
  /** The download question is shown. */
  asking = $state(false);
  /** Bumps when the looks arrive. */
  version = $state(0);
  /** The render data (large typed arrays, so not reactive). */
  looks: ProfileLooks | null = null;
  private loading: Promise<ProfileLooks | null> | null = null;
  private downloading: Promise<ProfileLooks> | null = null;
  private waiting: ((ok: boolean) => void)[] = [];

  get consent(): FujiConsent {
    try {
      const v = localStorage.getItem(CONSENT_KEY);
      return v === 'yes' || v === 'never' ? v : 'ask';
    } catch {
      return 'ask';
    }
  }

  private setConsent(v: FujiConsent): void {
    try {
      if (v === 'ask') localStorage.removeItem(CONSENT_KEY);
      else localStorage.setItem(CONSENT_KEY, v);
    } catch {
      // Not remembered: asked again next time.
    }
  }

  /** The looks kept in this browser, if any (never downloads). */
  load(): Promise<ProfileLooks | null> {
    if (this.looks) return Promise.resolve(this.looks);
    this.loading ??= cacheGet<unknown>('models', CACHE_KEY).then((stored) => {
      const data = validFujiLooksData(stored);
      if (data && !this.looks) this.use(data);
      if (!this.looks && this.status === 'unknown') this.status = 'absent';
      return this.looks;
    });
    return this.loading;
  }

  private use(data: FujiLooksData): ProfileLooks {
    this.looks = fujiProfileLooks(data);
    this.status = 'ready';
    this.error = null;
    this.version++;
    return this.looks;
  }

  /** Downloads, parses and keeps the looks (the user has agreed). */
  download(): Promise<ProfileLooks> {
    if (this.looks) return Promise.resolve(this.looks);
    this.downloading ??= (async () => {
      this.status = 'downloading';
      this.progress = 0;
      this.error = null;
      try {
        let done = 0;
        const texts = await Promise.all(
          FUJI_FILES.map(async (path) => {
            const res = await fetch(fujiLooksUrl(path), { credentials: 'omit' });
            if (!res.ok) throw new Error(`${path} could not be downloaded (HTTP ${res.status}).`);
            const text = await res.text();
            this.progress = ++done / FUJI_FILES.length;
            return [path, text] as const;
          }),
        );
        const data = parseFujiLooks(Object.fromEntries(texts));
        this.setConsent('yes');
        await cachePut('models', CACHE_KEY, data, dataBytes(data));
        return this.use(data);
      } catch (e) {
        this.status = 'error';
        this.error = `The Fujifilm film looks could not be downloaded: ${e instanceof Error ? e.message : String(e)}`;
        throw e;
      } finally {
        this.downloading = null;
      }
    })();
    return this.downloading;
  }

  /** Asks (unless already agreed) and downloads; null when declined or the download failed. */
  async request(): Promise<ProfileLooks | null> {
    const have = await this.load();
    if (have) return have;
    if (this.consent !== 'yes') {
      const ok = await new Promise<boolean>((resolve) => {
        this.waiting.push(resolve);
        this.asking = true;
      });
      if (!ok) return null;
    }
    try {
      return await this.download();
    } catch {
      return null;
    }
  }

  /** For exports: the kept looks, or a download only if the user already agreed to one. */
  async quiet(): Promise<ProfileLooks | null> {
    const have = await this.load();
    if (have || this.consent !== 'yes') return have;
    try {
      return await this.download();
    } catch {
      return null;
    }
  }

  answer(ok: boolean): void {
    this.asking = false;
    for (const w of this.waiting.splice(0)) w(ok);
  }

  /** "Don't ask again" for the offer shown when a Fujifilm RAW opens. */
  never(): void {
    this.setConsent('never');
  }
}

export const fujiLooks = new FujiLooks();

/** Size shown when asking. */
export const FUJI_LOOKS_MB = Math.round(FUJI_LOOKS_SOURCE.approxBytes / 1e6);
