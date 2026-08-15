import {
  DynamicBorder,
  getSettingsListTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import type { DevelopmentEnvironmentsConfig } from "../config.ts";
import { ENVIRONMENT_IDS, type EnvironmentId } from "./types.ts";

const LABELS: Record<EnvironmentId, string> = {
  go: "Go",
  python: "Python",
  node: "Node.js",
  pnpm: "pnpm",
  kubectl: "kubectl",
};

export async function selectDevelopmentEnvironments(
  ctx: ExtensionContext,
  config: DevelopmentEnvironmentsConfig,
): Promise<string | undefined> {
  if (ctx.mode !== "tui") return undefined;
  const selected = new Set<EnvironmentId>(
    config.selected.filter((id): id is EnvironmentId => (
      (ENVIRONMENT_IDS as readonly string[]).includes(id)
    )),
  );
  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(
      theme.fg("accent", theme.bold("Sandbox development environments")),
      1,
      0,
    ));
    const items: SettingItem[] = ENVIRONMENT_IDS.map((id) => ({
      id,
      label: profileLabel(id, config),
      currentValue: selected.has(id) ? "on" : "off",
      values: ["off", "on"],
    }));
    const settings = new SettingsList(
      items,
      Math.min(items.length + 2, 12),
      getSettingsListTheme(),
      (id, value) => {
        if (value === "on") selected.add(id as EnvironmentId);
        else selected.delete(id as EnvironmentId);
      },
      () => done(undefined),
    );
    container.addChild(settings);
    container.addChild(new Text(
      theme.fg("dim", "Enter toggles · Esc continues startup"),
      1,
      0,
    ));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => settings.handleInput?.(data),
    };
  });
  return environmentSelectionFlag([...selected], config);
}

export function environmentSelectionFlag(
  selected: EnvironmentId[],
  config: DevelopmentEnvironmentsConfig,
): string {
  if (selected.length === 0) return "none";
  const selectedSet = new Set(selected);
  return ENVIRONMENT_IDS
    .filter((id) => selectedSet.has(id))
    .map((id) => {
      const version = config.profiles[id].version;
      return version ? `${id}@${version}` : id;
    })
    .join(",");
}

function profileLabel(id: EnvironmentId, config: DevelopmentEnvironmentsConfig): string {
  const version = config.profiles[id].version;
  const dependency = id === "pnpm" ? " · requires Node.js" : "";
  return `${LABELS[id]}${version ? ` ${version}` : " · local/auto"}${dependency}`;
}
