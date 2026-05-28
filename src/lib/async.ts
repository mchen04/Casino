/** Promise-based delay for sequencing animations (deal → pause → reveal). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
