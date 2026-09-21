import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '../shared/types'
import type { JobEvent, OrgRole, RdsApi, OAuthBeginInput, TemplateKind } from '../shared/types'
import type { WizardConfig, WizardStep } from '../shared/wizard'

const api: RdsApi = {
  listOrgs: () => ipcRenderer.invoke(IPC.listOrgs),
  refreshOrgs: () => ipcRenderer.invoke(IPC.refreshOrgs),
  setOrgRole: (connectionId: string, role: OrgRole) =>
    ipcRenderer.invoke(IPC.setOrgRole, connectionId, role),
  verifyOrg: (connectionId: string) => ipcRenderer.invoke(IPC.verifyOrg, connectionId),
  orgRemove: (connectionId: string) => ipcRenderer.invoke(IPC.orgRemove, connectionId),
  oauthBegin: (input: OAuthBeginInput) => ipcRenderer.invoke(IPC.oauthBegin, input),
  oauthDisconnect: (connectionId: string) => ipcRenderer.invoke(IPC.oauthDisconnect, connectionId),
  readinessCheck: (deploymentId: number) => ipcRenderer.invoke(IPC.readinessCheck, deploymentId),
  readinessCreateExtId: (deploymentId: number, objectName: string) =>
    ipcRenderer.invoke(IPC.readinessCreateExtId, deploymentId, objectName),
  readinessProvisionExtIds: (deploymentId: number) =>
    ipcRenderer.invoke(IPC.readinessProvisionExtIds, deploymentId),
  targetKeyedObjects: (input: { targetConnectionId: string; objectNames: string[] }) =>
    ipcRenderer.invoke(IPC.targetKeyedObjects, input),
  describeGlobal: (connectionId: string) => ipcRenderer.invoke(IPC.describeGlobal, connectionId),
  describeObject: (connectionId: string, objectApiName: string) =>
    ipcRenderer.invoke(IPC.describeObject, connectionId, objectApiName),
  jobList: () => ipcRenderer.invoke(IPC.jobList),
  jobCancel: (jobId: string) => ipcRenderer.invoke(IPC.jobCancel, jobId),
  jobDemo: () => ipcRenderer.invoke(IPC.jobDemo),
  onJobEvent: (cb: (event: JobEvent) => void) => {
    const listener = (_e: IpcRendererEvent, event: JobEvent): void => cb(event)
    ipcRenderer.on(IPC.jobEvents, listener)
    return () => ipcRenderer.removeListener(IPC.jobEvents, listener)
  },
  draftCreate: (input: { name: string; sourceConnectionId: string; targetConnectionId: string }) =>
    ipcRenderer.invoke(IPC.draftCreate, input),
  draftSave: (input: { deploymentId: number; step: WizardStep; config: WizardConfig }) =>
    ipcRenderer.invoke(IPC.draftSave, input),
  draftLoad: (deploymentId: number) => ipcRenderer.invoke(IPC.draftLoad, deploymentId),
  draftList: () => ipcRenderer.invoke(IPC.draftList),
  draftDelete: (deploymentId: number) => ipcRenderer.invoke(IPC.draftDelete, deploymentId),
  deploymentAssignRoles: (deploymentId: number) =>
    ipcRenderer.invoke(IPC.deploymentAssignRoles, deploymentId),
  planGet: (deploymentId: number) => ipcRenderer.invoke(IPC.planGet, deploymentId),
  planReorder: (input: { deploymentId: number; objectOrder: string[] }) =>
    ipcRenderer.invoke(IPC.planReorder, input),
  automationDiscover: (deploymentId: number) =>
    ipcRenderer.invoke(IPC.automationDiscover, deploymentId),
  objectsIntersection: (input: {
    sourceConnectionId: string
    targetConnectionId: string
    force?: boolean
  }) => ipcRenderer.invoke(IPC.objectsIntersection, input),
  filterValidate: (input: {
    connectionId: string
    objectName: string
    filterClause: string
    targetConnectionId?: string
  }) => ipcRenderer.invoke(IPC.filterValidate, input),
  sampleGet: (input: { connectionId: string; objectName: string; fieldNames: string[] }) =>
    ipcRenderer.invoke(IPC.sampleGet, input),
  fieldsPopulated: (input: { connectionId: string; objectName: string; fieldNames: string[] }) =>
    ipcRenderer.invoke(IPC.fieldsPopulated, input),
  mappingsSuggest: (input: { sourceConnectionId: string; targetConnectionId: string }) =>
    ipcRenderer.invoke(IPC.mappingsSuggest, input),
  templateList: (kind: TemplateKind) => ipcRenderer.invoke(IPC.templateList, kind),
  templateSave: (input: { kind: TemplateKind; name: string; payload: unknown }) =>
    ipcRenderer.invoke(IPC.templateSave, input),
  templateRename: (input: { id: number; name: string }) =>
    ipcRenderer.invoke(IPC.templateRename, input),
  templateDelete: (id: number) => ipcRenderer.invoke(IPC.templateDelete, id),
  analyze: (deploymentId: number) => ipcRenderer.invoke(IPC.analyze, deploymentId),
  deployStart: (deploymentId: number) => ipcRenderer.invoke(IPC.deployStart, deploymentId),
  deployRunState: (deploymentId: number) => ipcRenderer.invoke(IPC.deployRunState, deploymentId)
}

contextBridge.exposeInMainWorld('rds', api)
