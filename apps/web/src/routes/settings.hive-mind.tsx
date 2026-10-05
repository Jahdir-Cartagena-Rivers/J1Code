import { createFileRoute } from "@tanstack/react-router";
import { HiveMindSettingsPanel } from "../components/settings/HiveMindSettings";
export const Route = createFileRoute("/settings/hive-mind")({ component: HiveMindSettingsPanel });
