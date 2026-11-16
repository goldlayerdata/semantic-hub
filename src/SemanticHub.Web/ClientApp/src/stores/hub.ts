import { create } from "zustand";
import { Api, describeError } from "../api";
import type { Discovered, HubModel, Status } from "../types";

type HubState = {
  status: Status | null;
  statusError: string | null;
  models: HubModel[];
  modelsLoaded: boolean;
  modelsError: string | null;
  discovered: Discovered[];
  discoveredLoaded: boolean;
  discoveredError: string | null;
  loadStatus: () => Promise<void>;
  loadModels: () => Promise<void>;
  loadDiscovered: () => Promise<void>;
  setModels: (m: HubModel[]) => void;
};

export const useHub = create<HubState>((set) => ({
  status: null,
  statusError: null,
  models: [],
  modelsLoaded: false,
  modelsError: null,
  discovered: [],
  discoveredLoaded: false,
  discoveredError: null,

  loadStatus: async () => {
    try {
      set({ status: await Api.status(), statusError: null });
    } catch (e) {
      // Drop the stale status so the chip turns red instead of showing an old "ready".
      set({ status: null, statusError: describeError(e).message });
    }
  },
  loadModels: async () => {
    try {
      const models = (await Api.models()) ?? [];
      set({ models, modelsLoaded: true, modelsError: null });
    } catch (e) {
      set({ modelsLoaded: true, modelsError: describeError(e).message });
    }
  },
  loadDiscovered: async () => {
    try {
      set({ discovered: (await Api.discovered()) ?? [], discoveredLoaded: true, discoveredError: null });
    } catch (e) {
      set({ discoveredLoaded: true, discoveredError: describeError(e).message });
    }
  },
  setModels: (models) => set({ models }),
}));

export const useModel = (id: string | undefined) => useHub((s) => s.models.find((m) => m.id === id));
