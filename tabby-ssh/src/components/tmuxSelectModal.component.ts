import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { TmuxSessionInfo, TmuxSocket, validateSessionName } from '../session/tmux'

export interface TmuxSelection {
    session?: TmuxSessionInfo
    mode: 'share'|'readonly'
    takeover: boolean
}

/** @hidden */
@Component({
    template: `
        <div class="modal-header"><h4 class="modal-title">SSH session</h4></div>
        <div class="modal-body">
            <p>Choose a tmux session or open an ordinary SSH shell.</p>
            <label>Socket</label>
            <select class="form-control" [(ngModel)]="socket.kind" (ngModelChange)="socketChanged()" [disabled]="busy || restoring">
                <option value="default">Default</option><option value="name">Named (-L)</option><option value="path">Path (-S)</option>
            </select>
            <input *ngIf="socket.kind !== 'default'" class="form-control" [(ngModel)]="socket.value" (ngModelChange)="socketChanged()" [disabled]="busy || restoring" placeholder="Socket name or path">
            <button class="btn btn-secondary mt-2" (click)="refresh()" [disabled]="busy">Refresh sessions</button>
            <p *ngIf="error" class="text-danger mt-2">{{error}}</p>
            <p *ngIf="!canBind">tmux recovery requires host-key verification. Ordinary SSH remains available.</p>
            <p *ngIf="!available">tmux is unavailable. Nothing will be installed on this host.</p>
            <p *ngIf="available && !sessions.length">No sessions on this socket.</p>
            <select *ngIf="sessions.length" class="form-control mt-2" [(ngModel)]="selected" [disabled]="busy">
                <option *ngFor="let session of sessions" [ngValue]="session">{{label(session)}} · {{session.sessionID}} · {{session.clients}} clients</option>
            </select>
            <p *ngIf="selected?.clients">Session occupied. Shared/read-only access does not revoke other clients. Explicit takeover detaches current clients.</p>
            <select class="form-control mt-2" [(ngModel)]="action" [disabled]="busy">
                <option value="share">Shared</option><option value="readonly">Read-only</option><option value="takeover">Explicit takeover</option>
            </select>
            <button class="btn btn-primary mt-2" (click)="attach()" [disabled]="busy || !selected || !canBind">Attach selected session</button>
            <div *ngIf="available && canBind && !restoring" class="mt-3">
                <input class="form-control" [(ngModel)]="name" [disabled]="busy" placeholder="New session name">
                <button class="btn btn-primary mt-2" (click)="create()" [disabled]="busy || !name">Create new session</button>
            </div>
        </div>
        <div class="modal-footer">
            <button *ngIf="!restoring" class="btn btn-secondary" (click)="plain()" [disabled]="busy">Ordinary SSH</button>
            <button class="btn btn-secondary" (click)="cancel()">Cancel</button>
        </div>`,
})
export class TmuxSelectModalComponent {
    socket: TmuxSocket = { kind: 'default', value: '' }
    sessions: TmuxSessionInfo[] = []
    selected: TmuxSessionInfo|null = null
    action = 'share'
    name = ''
    busy = false
    available = true
    canBind = true
    restoring = false
    error = ''
    load: () => Promise<TmuxSessionInfo[]>
    make: (name: string) => Promise<TmuxSessionInfo>

    constructor (private modal: NgbActiveModal) { }

    label (session: TmuxSessionInfo): string { return JSON.stringify(session.name) }

    socketChanged (): void {
        this.sessions = []
        this.selected = null
    }

    async refresh (): Promise<void> {
        if (this.busy) { return }
        this.busy = true
        this.error = ''
        try {
            this.sessions = await this.load()
            this.selected = this.sessions[0] ?? null
        } catch (error) {
            this.error = String(error)
        } finally {
            this.busy = false
        }
    }

    attach (): void {
        if (!this.busy && this.selected) {
            this.modal.close({ session: this.selected, mode: this.action === 'readonly' ? 'readonly' : 'share', takeover: this.action === 'takeover' } as TmuxSelection)
        }
    }

    async create (): Promise<void> {
        if (this.busy) { return }
        this.busy = true
        this.error = ''
        try {
            validateSessionName(this.name)
            const session = await this.make(this.name)
            this.modal.close({ session, mode: 'share', takeover: false } as TmuxSelection)
        } catch (error) {
            this.error = String(error)
        } finally {
            this.busy = false
        }
    }

    plain (): void { this.modal.close({ mode: 'share', takeover: false } as TmuxSelection) }
    cancel (): void { this.modal.dismiss('cancel') }
}
