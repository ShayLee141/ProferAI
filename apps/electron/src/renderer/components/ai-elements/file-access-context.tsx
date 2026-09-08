import * as React from 'react'

/** 文件引用所属的 Agent 会话；缺失时必须 fail closed。 */
const FileAccessSessionContext = React.createContext<string | undefined>(undefined)

export function FileAccessSessionProvider({ sessionId, children }: { sessionId?: string; children: React.ReactNode }): React.ReactElement {
  return <FileAccessSessionContext.Provider value={sessionId}>{children}</FileAccessSessionContext.Provider>
}

export function useFileAccessSessionId(): string | undefined {
  return React.useContext(FileAccessSessionContext)
}
