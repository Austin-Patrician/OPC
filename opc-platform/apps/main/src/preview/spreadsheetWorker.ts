import { parentPort as workerParentPort } from 'node:worker_threads';
import type { SpreadsheetPageResult } from '@opc/shared/ipc';
import { readSpreadsheetPageFromFile, type ReadSpreadsheetPageInput } from './spreadsheetReader';

export interface SpreadsheetWorkerRequest {
  id: number;
  payload: ReadSpreadsheetPageInput;
}

export interface SpreadsheetWorkerResponse {
  id: number;
  result: SpreadsheetPageResult;
}

interface UtilityParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

function handleWorkerRequest(
  postMessage: (message: SpreadsheetWorkerResponse) => void,
  message: SpreadsheetWorkerRequest,
): void {
  void readSpreadsheetPageFromFile(message.payload)
    .then((result) => {
      postMessage({ id: message.id, result });
    })
    .catch((error: unknown) => {
      postMessage({
        id: message.id,
        result: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
}

const utilityPort = (process as unknown as { parentPort?: UtilityParentPort }).parentPort;
if (utilityPort) {
  utilityPort.on('message', (event) => {
    handleWorkerRequest(
      (res) => utilityPort.postMessage(res),
      event.data as SpreadsheetWorkerRequest,
    );
  });
} else if (workerParentPort) {
  const port = workerParentPort;
  port.on('message', (message: SpreadsheetWorkerRequest) => {
    handleWorkerRequest((res) => port.postMessage(res), message);
  });
}
