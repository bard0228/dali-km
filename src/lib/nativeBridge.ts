export interface DaliNativeBridgeApi {
  isNativeApp?: () => boolean;
  getAppVersion?: () => string;
  syncSettings?: (settingsJson: string) => void;
  consumeSharedPayload?: () => string;
  processUrlInEdgeHarvester?: (payloadJson: string) => void;
  cancelEdgeHarvester?: () => void;
  readClipboardText?: () => string;
}

export interface NativeProgressEvent {
  stage:
    | 'fetching'
    | 'downloading'
    | 'gemini'
    | 'keyframes'
    | 'uploading'
    | 'done'
    | 'cancelled'
    | 'error';
  message: string;
  noteId?: string;
  url?: string;
}

declare global {
  interface Window {
    DaliNativeBridge?: DaliNativeBridgeApi;
    onDaliNativeProgress?: (ev: NativeProgressEvent) => void;
    onDaliNativeShared?: (payload: { url?: string; text?: string }) => void;
    handleDaliNativeBack?: () => boolean;
  }
}

export function isNativeApkEnv(): boolean {
  try {
    return Boolean(window.DaliNativeBridge && window.DaliNativeBridge.isNativeApp?.());
  } catch {
    return false;
  }
}
