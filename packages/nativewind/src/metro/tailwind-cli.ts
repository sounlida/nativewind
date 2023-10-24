import net from "node:net";
import { spawn } from "node:child_process";
import { Stats, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { ServerOptions, Server, WebSocket } from "ws";
import type { GetTransformOptionsOpts } from "metro-config";
import {
  CssToReactNativeRuntimeOptions,
  cssToReactNativeRuntime,
} from "react-native-css-interop/css-to-rn";

import { getOutput } from "./common";

export interface TailwindCliOptions extends GetTransformOptionsOpts {
  output: string;
  hotServerOptions: ServerOptions;
  cssToReactNativeRuntime?: CssToReactNativeRuntimeOptions;
}

export async function tailwindCli(input: string, options: TailwindCliOptions) {
  let done: (nativewindOptions?: Record<string, any>) => void;
  let nativewindOptions: Record<string, any> = {};
  const deferred = new Promise<Record<string, any> | undefined>(
    (resolve) => (done = resolve),
  );

  const env = {
    ...process.env,
    NATIVEWIND_NATIVE: options.platform !== "web" ? "1" : undefined,
  };

  const platform = options.platform === "web" ? "web" : "native";
  process.stdout.write(`tailwindcss(${platform}) rebuilding... `);

  const timeout = setTimeout(() => {
    if (options.dev && !process.env.CI) {
      console.warn(
        `tailwindcss(${platform}) is taking a long time to build, please read https://tailwindcss.com/docs/content-configuration#pattern-recommendations to speed up your build time`,
      );
    }
    // 1 minute.
  }, 60000);

  mkdirSync(dirname(options.output), { recursive: true });

  const output = getOutput(options.output, options);

  const spawnCommands = ["tailwindcss", "--input", input, "--output", output];

  let firstRun = true;
  let latestStat: Stats | undefined;
  let latestStyleData: string = "{}";
  let version = 0;
  let startedWSServer = false;
  const connections = new Map<WebSocket, number>();

  if (options.dev && options.hot) {
    spawnCommands.push("--watch");

    if (options.platform !== "web") {
      startedWSServer = true;

      if (!options.hotServerOptions.port) {
        options.hotServerOptions.port = await getAvailablePort();
      }

      nativewindOptions.fastRefreshPort = options.hotServerOptions.port;

      const wss = new Server(options.hotServerOptions);
      wss.on("connection", (ws) => {
        connections.set(ws, version);
        ws.on("close", () => connections.delete(ws));
        ws.send(latestStyleData);
      });
    }
  }

  const { stderr } = spawn("npx", spawnCommands, {
    shell: true,
    env,
  });

  stderr.on("data", (data: Buffer | string) => {
    data = data.toString();

    if (!data.includes("Done in")) return;

    if (startedWSServer) {
      const stat = statSync(output);

      if (stat.mtimeMs === latestStat?.mtimeMs) return;
      latestStat = stat;
      version = version + 1;

      latestStyleData = JSON.stringify(
        cssToReactNativeRuntime(
          readFileSync(output, "utf-8"),
          options.cssToReactNativeRuntime,
        ),
      );
      nativewindOptions.initialData = latestStyleData;

      for (const [ws, lastVersion] of connections) {
        if (lastVersion !== version) {
          ws.send(latestStyleData);
          connections.set(ws, version);
        }
      }
    }

    if (firstRun) {
      firstRun = false;
      clearTimeout(timeout);
      done(nativewindOptions);
    }
  });

  return deferred;
}

async function getAvailablePort(port = 8089): Promise<number> {
  return checkAvailablePort(port).catch(() => getAvailablePort(port + 1));
}

function checkAvailablePort(port: number) {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);

    server.listen({ port }, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}
