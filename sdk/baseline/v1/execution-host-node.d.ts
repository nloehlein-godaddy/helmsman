import type { ExecutionHostIdentityV1, ExecutionHostLaunchSpecV1 } from "./execution-host.js";
export interface ExecutionHostLaunchReceiptV1 extends ExecutionHostIdentityV1 {
    readonly version: 1;
    readonly pid: number;
    readonly processStart: string | null;
}
export interface ExecutionHostExitReceiptV1 extends ExecutionHostLaunchReceiptV1 {
    readonly exitCode: number;
}
export declare function executionHostProcessStartIdentity(pid: number): Promise<string | null>;
export declare function isExecutionHostIdentityMatch(left: ExecutionHostIdentityV1, right: ExecutionHostIdentityV1): boolean;
export declare function readExecutionHostLaunchReceipt(identity: ExecutionHostIdentityV1): Promise<ExecutionHostLaunchReceiptV1 | null>;
export declare function readExecutionHostExitReceipt(spec: ExecutionHostLaunchSpecV1): Promise<ExecutionHostExitReceiptV1 | null>;
export declare function isExecutionHostProcessOwned(pid: number, processStart: string | null): Promise<boolean>;
