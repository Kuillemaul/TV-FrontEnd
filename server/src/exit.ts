/**
 * End the process for good. Plain process.exit() can hang forever here: Node waits for its
 * worker threads on exit, and the ones reading remotes/controllers from /dev/input are stuck
 * in read() until the next button press. SIGKILL can't hang, and systemd (Restart=always)
 * starts Hearth again either way.
 */
export function hardExit(): never {
  process.kill(process.pid, 'SIGKILL');
  // Unreachable; satisfies the type checker.
  throw new Error('exit');
}
