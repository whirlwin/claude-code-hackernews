export type IsHidden = boolean

declare module 'claude-code' {
  interface PluginState {
    'hackernews': { isHidden: IsHidden }
  }
}
