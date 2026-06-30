export interface ErrorBody {
  code: string;
  message: string;
}

export function errorBody(code: string, message: string): ErrorBody {
  return { code, message };
}
