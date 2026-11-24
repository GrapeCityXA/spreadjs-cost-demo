// Same-origin API by default; BASE_URL keeps this correct under a subpath build.
export const API_BASE_URL = import.meta.env.VITE_API_URL || `${import.meta.env.BASE_URL}api`
