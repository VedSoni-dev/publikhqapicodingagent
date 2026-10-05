import { contextBridge, ipcRenderer } from 'electron';
const invoke = async (channel: string, ...args: unknown[]) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('publik', {
  state: () => invoke('state'), provision: (accepted: boolean) => invoke('provision', accepted),
  refresh: () => invoke('refresh'), saveOwn: (value: unknown) => invoke('save-own', value),
  usePublik: () => invoke('use-publik'), openLink: (kind: string) => invoke('open-link', kind),
  launch: (tier: string) => invoke('launch', tier), home: () => invoke('home'),
  resume: () => invoke('resume'), stop: () => invoke('stop'),
  onState: (callback: (value: unknown) => void) => ipcRenderer.on('state', (_event, value) => callback(value)),
  onHome: (callback: () => void) => ipcRenderer.on('home', callback),
  onWorkspace: (callback: () => void) => ipcRenderer.on('workspace', callback),
});
