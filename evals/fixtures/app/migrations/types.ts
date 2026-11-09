export interface Migration {
  id: string;
  up: string;
  // Optional in the type so the runner can report a missing down clearly; every migration should have one.
  down?: string;
}
