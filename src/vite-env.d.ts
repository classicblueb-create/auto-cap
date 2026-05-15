/// <reference types="vite/client" />

declare module '@ffmpeg/core?url' {
  const content: string;
  export default content;
}

declare module '@ffmpeg/core/wasm?url' {
  const content: string;
  export default content;
}
