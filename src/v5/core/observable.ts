import {
    Lambda,
    ComputedValue,
    IDependencyTree,
    IDerivation,
    IDerivationState,
    TraceMode,
    getDependencyTree,
    globalState,
    runReactions,
    checkIfStateReadsAreAllowed
} from "../internal"

export interface IDepTreeNode {
    name: string
    observing?: IObservable[]
}

export interface IObservable extends IDepTreeNode {
    diffValue: number
    /**
     * Id of the derivation *run* that last accessed this observable.
     * If this id equals the *run* id of the current derivation,
     * the dependency is already established
     */
    lastAccessedBy: number
    isBeingObserved: boolean

    lowestObserverState: IDerivationState // Used to avoid redundant propagations
    isPendingUnobservation: boolean // Used to push itself to global.pendingUnobservations at most once per batch.

    observers: Set<IDerivation>

    onBecomeUnobserved(): void
    onBecomeObserved(): void

    onBecomeUnobservedListeners: Set<Lambda> | undefined
    onBecomeObservedListeners: Set<Lambda> | undefined
}

export function hasObservers(observable: IObservable): boolean {
    return observable.observers && observable.observers.size > 0
}

export function getObservers(observable: IObservable): Set<IDerivation> {
    return observable.observers
}

// function invariantObservers(observable: IObservable) {
//     const list = observable.observers
//     const map = observable.observersIndexes
//     const l = list.length
//     for (let i = 0; i < l; i++) {
//         const id = list[i].__mapid
//         if (i) {
//             invariant(map[id] === i, "INTERNAL ERROR maps derivation.__mapid to index in list") // for performance
//         } else {
//             invariant(!(id in map), "INTERNAL ERROR observer on index 0 shouldn't be held in map.") // for performance
//         }
//     }
//     invariant(
//         list.length === 0 || Object.keys(map).length === list.length - 1,
//         "INTERNAL ERROR there is no junk in map"
//     )
// }
export function addObserver(observable: IObservable, node: IDerivation) {
    // invariant(node.dependenciesState !== -1, "INTERNAL ERROR, can add only dependenciesState !== -1");
    // invariant(observable._observers.indexOf(node) === -1, "INTERNAL ERROR add already added node");
    // invariantObservers(observable);

    observable.observers.add(node)
    if (observable.lowestObserverState > node.dependenciesState)
        observable.lowestObserverState = node.dependenciesState

    // invariantObservers(observable);
    // invariant(observable._observers.indexOf(node) !== -1, "INTERNAL ERROR didn't add node");
}

export function removeObserver(observable: IObservable, node: IDerivation) {
    // invariant(globalState.inBatch > 0, "INTERNAL ERROR, remove should be called only inside batch");
    // invariant(observable._observers.indexOf(node) !== -1, "INTERNAL ERROR remove already removed node");
    // invariantObservers(observable);
    observable.observers.delete(node)
    if (observable.observers.size === 0) {
        // deleting last observer
        queueForUnobservation(observable)
    }
    // invariantObservers(observable);
    // invariant(observable._observers.indexOf(node) === -1, "INTERNAL ERROR remove already removed node2");
}

export function queueForUnobservation(observable: IObservable) {
    if (observable.isPendingUnobservation === false) {
        // invariant(observable._observers.length === 0, "INTERNAL ERROR, should only queue for unobservation unobserved observables");
        observable.isPendingUnobservation = true
        globalState.pendingUnobservations.push(observable)
    }
}

/**
 * reportChanged函数在Atom类中定义
 * 
 * public reportChanged() {
        startBatch()
        propagateChanged(this)
        endBatch()
    }
 * 
 * 1、通过 observable.reportChanged 方法将响应式数据变更的信息上报到全局环境。
 * 2、observable.reportChanged 执行过程中，使用 startBatch, endBatch 函数将 propagateChange(observable) 包裹到事务处理周期中。
 *    mobx 中的事务通过 globalState.inBatch 计数器标识：startBatch 阶段，globalState.inBatch 加 1；endBatch 阶段，globalState.inBatch 减 1；当 globalState.inBatch 为 0 时，表示单个事务周期结束。
 *    事务的意义就在于将并行的响应式数据变更视为一组，在一组变更完成之后，才执行相应的衍生。
 * 3、在一个事务处理周期中，首先通过 propagateChange(observable) 间接将 derivation 加入到 globalState.pendingReactions 队列中。
 *    该过程中通过调用 derivation.onBecameStale 方法实现。对于 reaction 反应，在事务执行期间，直接将 reaction 添加到 globalState.pendingReactions 队列；
 *    对于 computedValue 计算属性，间接将观察 computedValue 变更的 reaction 添加到 globalState.pendingReactions 队列。
 * 4、endBatch 阶段，通过调用 runReactions 函数遍历 globalState.pendingReactions 队列，执行 reaction.runReaction 方法。每个 reaction.runReaction 方法内部的执行逻辑中，包含 observer 依赖和状态更新，以及执行用户端处理逻辑。
 * 5、事务的尾端，将遍历 globalState.pendingUnobservations 数组，并调用 observable.onBecomeUnobserved 方法。
 *    对于计算属性，额外调用 computedValue.suspend 方法。目的是当没有观察者监听这些响应式数据变更时，就无需将数据变更上报到全局环境。
 */

/**
 * Batch starts a transaction, at least for purposes of memoizing ComputedValues when nothing else does.
 * During a batch `onBecomeUnobserved` will be called at most once per observable.
 * Avoids unnecessary recalculations.
 */
export function startBatch() {
    globalState.inBatch++
}

export function endBatch() {
    if (--globalState.inBatch === 0) {
        runReactions()
        // the batch is actually about to finish, all unobserving should happen here.
        const list = globalState.pendingUnobservations
        for (let i = 0; i < list.length; i++) {
            const observable = list[i]
            observable.isPendingUnobservation = false
            if (observable.observers.size === 0) {
                if (observable.isBeingObserved) {
                    // if this observable had reactive observers, trigger the hooks
                    observable.isBeingObserved = false
                    observable.onBecomeUnobserved()
                }
                if (observable instanceof ComputedValue) {
                    // computed values are automatically teared down when the last observer leaves
                    // this process happens recursively, this computed might be the last observabe of another, etc..
                    observable.suspend()
                }
            }
        }
        globalState.pendingUnobservations = []
    }
}

/**
 * 
 * 当 observable 被观察时，需要显示调用 reportObserved 方法；
 * 当 observable 数据变更时，需要显示调用 reportChanged 方法。
 * 
 * 当响应式数据被衍生订阅时，将会执行 obsrvable.reportObserved 方法。
 * 在该方法的执行过程中，就是针对当前执行的衍生调用其观察的响应式数据的 onBecameObserved 方法；
 * 或者将该 obsrvable 实例添加到 globalState.pendingUnobservations 数组中，
 * 等待事务结束时，执行 observable.onBecomeUnobserved 与 computedValue.suspend 方法。
 */
export function reportObserved(observable: IObservable): boolean {
    checkIfStateReadsAreAllowed(observable)
   //global.trackingDerivation是用来判断当前是否在Reaction的环境中，一般是一下这两种情况
    /**
       example 1:
         autorun(()=>{
             代码是否处于这个里面
         })
       example 2:
         new Reaction('dsada',()=>{
             this.track(()=>{
                代码是否处于这个里面
             })
         })
    **/
    const derivation = globalState.trackingDerivation
    if (derivation !== null) {
        /**
         * Simple optimization, give each derivation run an unique id (runId)
         * Check if last time this observable was accessed the same runId is used
         * if this is the case, the relation is already known
         */
        if (derivation.runId !== observable.lastAccessedBy) {
            // 将 lastAccessedBy 置为 runId，标志着这轮收集依赖，这个 observable 已经处理过了
            observable.lastAccessedBy = derivation.runId
            // Tried storing newObserving, or observing, or both as Set, but performance didn't come close...
            // 给当前Reaction的上下文添加要观察的对象
            derivation.newObserving![derivation.unboundDepsCount++] = observable
            if (!observable.isBeingObserved) {
                observable.isBeingObserved = true
                observable.onBecomeObserved()
            }
        }
        return true
    } else if (observable.observers.size === 0 && globalState.inBatch > 0) {
        queueForUnobservation(observable)
    }

    return false
}

// function invariantLOS(observable: IObservable, msg: string) {
//     // it's expensive so better not run it in produciton. but temporarily helpful for testing
//     const min = getObservers(observable).reduce((a, b) => Math.min(a, b.dependenciesState), 2)
//     if (min >= observable.lowestObserverState) return // <- the only assumption about `lowestObserverState`
//     throw new Error(
//         "lowestObserverState is wrong for " +
//             msg +
//             " because " +
//             min +
//             " < " +
//             observable.lowestObserverState
//     )
// }

/**
 * NOTE: current propagation mechanism will in case of self reruning autoruns behave unexpectedly
 * It will propagate changes to observers from previous run
 * It's hard or maybe impossible (with reasonable perf) to get it right with current approach
 * Hopefully self reruning autoruns aren't a feature people should depend on
 * Also most basic use cases should be ok
 */

// Called by Atom when its value changes
export function propagateChanged(observable: IObservable) {
    // invariantLOS(observable, "changed start");
    if (observable.lowestObserverState === IDerivationState.STALE) return
    // 将自己变成不稳定的
    observable.lowestObserverState = IDerivationState.STALE

    // Ideally we use for..of here, but the downcompiled version is really slow...
    observable.observers.forEach(d => {
        // 有值改变 lowestObserverState 就置为 STALE，并通知给依赖它的 derivation
        if (d.dependenciesState === IDerivationState.UP_TO_DATE) {
            if (d.isTracing !== TraceMode.NONE) {
                logTraceInfo(d, observable)
            }
            d.onBecomeStale()
        }
        d.dependenciesState = IDerivationState.STALE
    })
    // invariantLOS(observable, "changed end");
}

// ComputedValue 值改变重新计算时调用
// Called by ComputedValue when it recalculate and its value changed
export function propagateChangeConfirmed(observable: IObservable) {
    // invariantLOS(observable, "confirmed start");
    if (observable.lowestObserverState === IDerivationState.STALE) return
    observable.lowestObserverState = IDerivationState.STALE

    observable.observers.forEach(d => {
        if (d.dependenciesState === IDerivationState.POSSIBLY_STALE)
            d.dependenciesState = IDerivationState.STALE
        else if (
            // 正在依赖收集阶段
            d.dependenciesState === IDerivationState.UP_TO_DATE // this happens during computing of `d`, just keep lowestObserverState up to date.
        )
            observable.lowestObserverState = IDerivationState.UP_TO_DATE
    })
    // invariantLOS(observable, "confirmed end");
}

// Used by computed when its dependency changed, but we don't wan't to immediately recompute.
export function propagateMaybeChanged(observable: IObservable) {
    // invariantLOS(observable, "maybe start");
    if (observable.lowestObserverState !== IDerivationState.UP_TO_DATE) return
    observable.lowestObserverState = IDerivationState.POSSIBLY_STALE

    observable.observers.forEach(d => {
        if (d.dependenciesState === IDerivationState.UP_TO_DATE) {
            d.dependenciesState = IDerivationState.POSSIBLY_STALE
            if (d.isTracing !== TraceMode.NONE) {
                logTraceInfo(d, observable)
            }
            d.onBecomeStale()
        }
    })
    // invariantLOS(observable, "maybe end");
}

function logTraceInfo(derivation: IDerivation, observable: IObservable) {
    console.log(
        `[mobx.trace] '${derivation.name}' is invalidated due to a change in: '${observable.name}'`
    )
    if (derivation.isTracing === TraceMode.BREAK) {
        const lines = []
        printDepTree(getDependencyTree(derivation), lines, 1)

        // prettier-ignore
        new Function(
`debugger;
/*
Tracing '${derivation.name}'

You are entering this break point because derivation '${derivation.name}' is being traced and '${observable.name}' is now forcing it to update.
Just follow the stacktrace you should now see in the devtools to see precisely what piece of your code is causing this update
The stackframe you are looking for is at least ~6-8 stack-frames up.

${derivation instanceof ComputedValue ? derivation.derivation.toString().replace(/[*]\//g, "/") : ""}

The dependencies for this derivation are:

${lines.join("\n")}
*/
    `)()
    }
}

function printDepTree(tree: IDependencyTree, lines: string[], depth: number) {
    if (lines.length >= 1000) {
        lines.push("(and many more)")
        return
    }
    lines.push(`${new Array(depth).join("\t")}${tree.name}`) // MWE: not the fastest, but the easiest way :)
    if (tree.dependencies) tree.dependencies.forEach(child => printDepTree(child, lines, depth + 1))
}
