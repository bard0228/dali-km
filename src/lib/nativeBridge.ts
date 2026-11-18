export interface DaliNativeBridgeApi {
  isNativeApp?: () => boolean;
  getAppVersion?: () => string;
  syncSettings?: (settingsJson: string) => void;
  consumeSharedPayload?: () => string;
  processUrlInEdgeHarvester?: (payloadJson: string) => void;
}

export interface NativeProgressEvent {
  stage: 'fetching' | 'downloading' | 'gemini' | 'keyframes' | 'uploading' | 'done' | 'error';
  message: string;
  noteId?: string;
  url?: string;
}

declare global {
  interface Window {
    DaliNativeBridge?: DaliNativeBridgeApi;
    onDaliNativeProgress?: (ev: NativeProgressEvent) => void;
    onDaliNativeShared?: (payload: { url?: string; text?: string }) => void;
  }
}

export function isNativeApkEnv(): boolean {
  try {
    return Boolean(window.DaliNativeBridge && window.DaliNativeBridge.isNativeApp?.());
  } catch {
    return false;
  }
}
