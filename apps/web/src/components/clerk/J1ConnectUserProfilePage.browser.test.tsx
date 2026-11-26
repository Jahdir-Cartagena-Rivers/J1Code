import type { EnvironmentId } from "@j1code/contracts";
import type { RelayClientEnvironmentRecord } from "@j1code/contracts/relay";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { J1ConnectEnvironmentRow } from "./J1ConnectUserProfilePage";

const environment: RelayClientEnvironmentRecord = {
  environmentId: "environment-1" as EnvironmentId,
  label: "Studio Mac",
  endpoint: {
    httpBaseUrl: "https://studio.example.com",
    wsBaseUrl: "wss://studio.example.com",
    providerKind: "cloudflare_tunnel",
  },
  linkedAt: "2026-08-12T12:00:00.000Z",
};

function EnvironmentRow({
  pending = false,
  onDeregister,
}: {
  pending?: boolean;
  onDeregister: (value: RelayClientEnvironmentRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <J1ConnectEnvironmentRow
      environment={environment}
      confirmationOpen={open}
      mutationPending={pending}
      onConfirmationChange={setOpen}
      onDeregister={onDeregister}
    />
  );
}

it("requires the inline confirmation and lets Cancel leave the environment registered", async () => {
  const deregister = vi.fn();
  await using _screen = await render(<EnvironmentRow onDeregister={deregister} />);
  const confirmation = page.getByRole("group", { name: "Confirm deregistration of Studio Mac" });
  await expect.element(confirmation).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Deregister", exact: true }).click();
  await expect.element(confirmation).toBeVisible();
  expect(deregister).not.toHaveBeenCalled();
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(confirmation).not.toBeVisible();
  expect(deregister).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Deregister", exact: true }).click();
  await confirmation.getByRole("button", { name: "Deregister", exact: true }).click();
  expect(deregister).toHaveBeenCalledExactlyOnceWith(environment);
});

it("blocks confirmation changes and submission while pending, then permits a deliberate retry", async () => {
  const deregister = vi.fn();
  await using screen = await render(<EnvironmentRow onDeregister={deregister} />);
  await page.getByRole("button", { name: "Deregister", exact: true }).click();
  const confirmation = page.getByRole("group", { name: "Confirm deregistration of Studio Mac" });
  await expect.element(confirmation).toBeVisible();
  await screen.rerender(<EnvironmentRow pending onDeregister={deregister} />);
  await expect.element(page.getByRole("button", { name: "Deregister", exact: true })).toBeDisabled();
  await expect.element(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect.element(confirmation.getByRole("button", { name: "Deregistering…", exact: true })).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  expect(deregister).not.toHaveBeenCalled();
  await expect.element(confirmation).toBeVisible();

  await screen.rerender(<EnvironmentRow onDeregister={deregister} />);
  await confirmation.getByRole("button", { name: "Deregister", exact: true }).click();
  expect(deregister).toHaveBeenCalledExactlyOnceWith(environment);
});
