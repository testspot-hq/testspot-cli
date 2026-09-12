import path from 'node:path'

declare const TESTSPOT_EXECUTABLE: boolean
export const cliName = typeof TESTSPOT_EXECUTABLE !== 'undefined' && TESTSPOT_EXECUTABLE ? 'testspot' : /^testspot(?:[._]|$)/i.test(path.basename(process.argv[1] ?? '')) ? 'testspot' : 'testpilot'
export function branded(message: string): string {
  return cliName === 'testspot' ? message.replace(/TESTPILOT_/g, 'TESTSPOT_').replace(/Testpilot/g, 'TestSpot') : message
}
