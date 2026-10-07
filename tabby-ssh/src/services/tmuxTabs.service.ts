import { Injectable } from '@angular/core'
import { bindingKey, TmuxBinding } from '../session/tmux'
import type { SSHTabComponent } from '../components/sshTab.component'

/** One owner per binding, including tabs nested in splits. */
@Injectable({ providedIn: 'root' })
export class TmuxTabsService {
    private owners = new Map<string, SSHTabComponent>()

    claim (binding: TmuxBinding, tab: SSHTabComponent): SSHTabComponent {
        const key = bindingKey(binding)
        const owner = this.owners.get(key)
        if (owner) { return owner }
        this.owners.set(key, tab)
        return tab
    }

    release (tab: SSHTabComponent): void {
        for (const [key, owner] of this.owners) {
            if (owner === tab) { this.owners.delete(key) }
        }
    }
}
