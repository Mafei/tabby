import { Injectable } from '@angular/core'
import { TmuxTabRegistry } from '../session/tmux'
import type { SSHTabComponent } from '../components/sshTab.component'

/** One owner per binding, including tabs nested in splits. */
@Injectable({ providedIn: 'root' })
export class TmuxTabsService extends TmuxTabRegistry<SSHTabComponent> { }
