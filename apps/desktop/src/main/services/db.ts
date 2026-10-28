import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectInfo, Settings } from '@peep/shared';

const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  autoSave: true,
};

interface StoreData {
  projects: ProjectInfo[];
  settings: Settings;
}

function encryptSecret(plainText: string | undefined): string | undefined {
  if (!plainText) return undefined;
  if (safeStorage?.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(plainText);
      return encrypted.toString('base64');
    } catch {
      return plainText;
    }
  }
  return plainText;
}

function decryptSecret(encryptedBase64: string | undefined): string | undefined {
  if (!encryptedBase64) return undefined;
  if (safeStorage?.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
    try {
      const buffer = Buffer.from(encryptedBase64, 'base64');
      return safeStorage.decryptString(buffer);
    } catch {
      return encryptedBase64;
    }
  }
  return encryptedBase64;
}

export class DatabaseService {
  private storePath: string;
  private data: StoreData = {
    projects: [],
    settings: { ...DEFAULT_SETTINGS },
  };

  constructor() {
    this.storePath = join(app?.getPath ? app.getPath('userData') : __dirname, 'peep-store.json');
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      const settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
      // Decrypt session token — it is a secret and must be stored encrypted
      if (settings.sessionToken) {
        settings.sessionToken = decryptSecret(settings.sessionToken);
      }
      if (settings.refreshToken) {
        settings.refreshToken = decryptSecret(settings.refreshToken);
      }
      if (settings.aiProviderApiKey) {
        settings.aiProviderApiKey = decryptSecret(settings.aiProviderApiKey);
      }
      this.data = {
        projects: parsed.projects ?? [],
        settings,
      };
    } catch {
      await this.persist();
    }

  }

  private async persist(): Promise<void> {
    await mkdir(join(this.storePath, '..'), { recursive: true });
    
    // Encrypt secrets (sessionToken, refreshToken) for the written file.
    // Session tokens must also be encrypted at rest.
    const settingsCopy = { ...this.data.settings };
    if (settingsCopy.sessionToken) {
      settingsCopy.sessionToken = encryptSecret(settingsCopy.sessionToken);
    }
    if (settingsCopy.refreshToken) {
      settingsCopy.refreshToken = encryptSecret(settingsCopy.refreshToken);
    }
    if (settingsCopy.aiProviderApiKey) {
      settingsCopy.aiProviderApiKey = encryptSecret(settingsCopy.aiProviderApiKey);
    }
    const storeCopy = {
      ...this.data,
      settings: settingsCopy
    };
    await writeFile(this.storePath, JSON.stringify(storeCopy, null, 2), 'utf-8');
  }

  getSettings(): Settings {
    // SECURITY: Strip all secrets before returning to renderer via IPC.
    const settings = { ...this.data.settings };
    return {
      ...settings,
      sessionToken: undefined,
      refreshToken: undefined,
      sessionConfigured: Boolean(this.data.settings.sessionToken),
      aiProviderApiKey: undefined,
      aiProviderApiKeyConfigured: !!this.data.settings.aiProviderApiKey,
    } as Settings;
  }

  getSettingsRaw(): Settings {
    return { ...this.data.settings };
  }

  async setSettings(partial: Partial<Settings>): Promise<Settings> {
    const next = { ...this.data.settings, ...partial };
    if (partial.sessionToken === '') {
      delete next.sessionToken;
    }
    if (partial.refreshToken === '') {
      delete next.refreshToken;
    }
    this.data.settings = next;
    await this.persist();
    return this.getSettings();
  }

  async upsertProject(project: ProjectInfo): Promise<void> {
    const index = this.data.projects.findIndex((p) => p.path === project.path);
    if (index >= 0) {
      this.data.projects[index] = project;
    } else {
      this.data.projects.push(project);
    }
    await this.persist();
  }

  getRecentProjects(limit = 10): ProjectInfo[] {
    return [...this.data.projects]
      .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
      .slice(0, limit);
  }
}
