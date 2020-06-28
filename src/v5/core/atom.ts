import {
    IDerivationState,
    IObservable,
    IDerivation,
    createInstanceofPredicate,
    endBatch,
    getNextId,
    noop,
    onBecomeObserved,
    onBecomeUnobserved,
    propagateChanged,
    reportObserved,
    startBatch
} from "../internal"
import { Lambda } from "../utils/utils"

export const $mobx = Symbol("mobx administration")

export interface IAtom extends IObservable {
    reportObserved()
    reportChanged()
}

/**
 * 1、observers 属性为 observable 绑定的观察者队列。
 * 2、lowestObserverState 属性为状态标识，用于标记数据是否被更新，需要执行相应的衍生。
 * 3、diffValue 属性用于实时更新 observable, observer 的依赖关系。
 * 4、onBecameUnobservered, onBecameObservered 钩子，分别在 observable 不被监听或被监听时得到调用。
 * 5、lastAcessedBy（最后消费 observable 的观察者 id）。
 * 6、isBeingObserved 属性用于使 onBecameObservered 钩子不被反复调用。
 * 7、isPendingUnobservation 属性用于使 onBecameUnobservered 钩子不被反复执行。
 */
export class Atom implements IAtom {
    isPendingUnobservation = false // for effective unobserving. BaseAtom has true, for extra optimization, so its onBecomeUnobserved never gets called, because it's not needed
    isBeingObserved = false
    observers = new Set<IDerivation>()

    diffValue = 0
    lastAccessedBy = 0
    lowestObserverState = IDerivationState.NOT_TRACKING
    /**
     * Create a new atom. For debugging purposes it is recommended to give it a name.
     * The onBecomeObserved and onBecomeUnobserved callbacks can be used for resource management.
     */
    constructor(public name = "Atom@" + getNextId()) {}

    public onBecomeObservedListeners: Set<Lambda> | undefined
    public onBecomeUnobservedListeners: Set<Lambda> | undefined

    public onBecomeObserved() {
        if (this.onBecomeObservedListeners) {
            this.onBecomeObservedListeners.forEach(listener => listener())
        }
    }

    public onBecomeUnobserved() {
        if (this.onBecomeUnobservedListeners) {
            this.onBecomeUnobservedListeners.forEach(listener => listener())
        }
    }

    /**
     * Invoke this method to notify mobx that your atom has been used somehow.
     * Returns true if there is currently a reactive context.
     */
    public reportObserved(): boolean {
        return reportObserved(this)
    }

    /**
     * Invoke this method _after_ this method has changed to signal mobx that all its observers should invalidate.
     */
    public reportChanged() {
        startBatch()
        propagateChanged(this)
        endBatch()
    }

    toString() {
        return this.name
    }
}

export const isAtom = createInstanceofPredicate("Atom", Atom)

export function createAtom(
    name: string,
    onBecomeObservedHandler: () => void = noop,
    onBecomeUnobservedHandler: () => void = noop
): IAtom {
    const atom = new Atom(name)
    // default `noop` listener will not initialize the hook Set
    if (onBecomeObservedHandler !== noop) {
        onBecomeObserved(atom, onBecomeObservedHandler)
    }

    if (onBecomeUnobservedHandler !== noop) {
        onBecomeUnobserved(atom, onBecomeUnobservedHandler)
    }
    return atom
}
