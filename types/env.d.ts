/// <reference types="node" />

declare namespace NodeJS {
  interface ProcessEnv {
    MOCK_MODE?: string;
    VOLVO_PRIMARY_KEY?: string;
    VOLVO_VCC_API_KEY?: string;
    VOLVO_ACCESS_TOKEN?: string;
    VOLVO_VIN?: string;
    NEXT_PUBLIC_MAPBOX_TOKEN?: string;
    MAPBOX_ACCESS_TOKEN?: string;
    OPEN_CHARGE_MAP_KEY?: string;
  }
}

export {};
