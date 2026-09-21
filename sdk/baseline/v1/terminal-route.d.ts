export interface TerminalRouteV1 {
    readonly version: 1;
    readonly surface: string | null;
    readonly pane: 'tabs' | 'screen' | null;
}
export declare function isTerminalSurfaceRefV1(value: unknown): value is string;
export declare function parseTerminalRouteV1(value: unknown): TerminalRouteV1 | null;
export declare function sameTerminalRouteV1(a: unknown, b: unknown): boolean;
