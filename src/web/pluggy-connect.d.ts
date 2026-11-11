// Tipos do widget carregado via CDN (https://cdn.pluggy.ai/pluggy-connect/v2.11.0/pluggy-connect.js).

export interface PluggyConnectItem {
  id: string;
  status: string;
  connector?: { id: number; name: string };
}

export interface PluggyConnectOptions {
  connectToken: string;
  includeSandbox?: boolean;
  connectorIds?: number[];
  updateItem?: string;
  onSuccess?: (data: { item: PluggyConnectItem }) => void;
  onError?: (error: { message: string; data?: { item?: PluggyConnectItem } }) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

declare global {
  class PluggyConnect {
    constructor(options: PluggyConnectOptions);
    init(): Promise<void>;
  }
}
