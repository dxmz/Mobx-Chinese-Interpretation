import {
    EMPTY_OBJECT,
    IEqualsComparer,
    IReactionDisposer,
    IReactionPublic,
    Lambda,
    Reaction,
    action,
    comparer,
    getNextId,
    invariant,
    isAction
} from "../internal"

export interface IAutorunOptions {
    delay?: number
    name?: string
    /**
     * Experimental.
     * Warns if the view doesn't track observables
     */
    requiresObservable?: boolean
    scheduler?: (callback: () => void) => any
    onError?: (error: any) => void
}

/**
 * autoRun 函数的处理流程为：
 * 1、构建 Reaction 实例。
 * 2、初始化调用 reaction.schedule 方法，初次调用用户端执行逻辑 ，
 *    绑定 observer 和 observable 的依赖关系。
 * 3、使用 reaction.track 包装用户端执行逻辑，在响应式数据变更后，
 *    既负责更新 observer 和 observable 的依赖关系，又负责调用用户端执行逻辑。
 * 用户端执行逻辑通常表现为视图变更，因此也被标识为 view 函数。
 * 
 * autorun 只会观察在执行提供的函数时所使用的数据
 * 当使用 autorun 时，所提供的函数总是立即被触发一次，然后每次它的依赖关系改变时会再次被触发。 
 * 相比之下，computed(function) 创建的函数只有当它有自己的观察者时才会重新计算，
 * 否则它的值会被认为是不相关的。
 * 
 * autorun(fn) 执行后（ fn 访问 observable），创建了一个 reaction，并建立以下依赖关系：
 * reaction.observing （数组）包含 fn 访问的所有 ObservableValue 实例；
 * 每个 ObservableValue 实例的属性 observers （数组）包含 reaction。
 * 
 */
/**
 * Creates a named reactive view and keeps it alive, so that the view is always
 * updated if one of the dependencies changes, even when the view is not further used by something else.
 * @param view The reactive view
 * 
 * disposer可以停止view的更新
 * @returns disposer function, which can be used to stop the view from being updated in the future.
 */
export function autorun(
    view: (r: IReactionPublic) => any,
    opts: IAutorunOptions = EMPTY_OBJECT
): IReactionDisposer {
    if (process.env.NODE_ENV !== "production") {
        invariant(typeof view === "function", "Autorun expects a function as first argument")
        invariant(
            isAction(view) === false,
            "Autorun does not accept actions since actions are untrackable"
        )
    }

    const name: string = (opts && opts.name) || (view as any).name || "Autorun@" + getNextId()
    const runSync = !opts.scheduler && !opts.delay
    let reaction: Reaction

    /**
     * Reaction的构造函数
     * constructor(
        public name: string = "Reaction@" + getNextId(),
        private onInvalidate: () => void,
        private errorHandler?: (error: any, derivation: IDerivation) => void,
        public requiresObservable = false
    ) {}
     */
    if (runSync) {
        // normal autorun
        reaction = new Reaction(
            name,
            function(this: Reaction) {
                this.track(reactionRunner)
            },
            opts.onError,
            opts.requiresObservable
        )
    } else {
        const scheduler = createSchedulerFromOptions(opts)
        // debounced autorun
        let isScheduled = false

        reaction = new Reaction(
            name,
            () => {
                if (!isScheduled) {
                    isScheduled = true
                    scheduler(() => {
                        isScheduled = false
                        if (!reaction.isDisposed) reaction.track(reactionRunner)
                    })
                }
            },
            opts.onError,
            opts.requiresObservable
        )
    }

    function reactionRunner() {
        view(reaction)
    }

    // 初始化绑定 reaction 和 observable 的依赖关系，并调用用户端执行逻辑 view
    reaction.schedule()
    return reaction.getDisposer()
}

export type IReactionOptions = IAutorunOptions & {
    fireImmediately?: boolean
    equals?: IEqualsComparer<any>
}

const run = (f: Lambda) => f()

function createSchedulerFromOptions(opts: IReactionOptions) {
    return opts.scheduler
        ? opts.scheduler
        : opts.delay
        ? (f: Lambda) => setTimeout(f, opts.delay!)
        : run
}

/**
 * Reaction
   用法: reaction(() => data, (data, reaction) => { sideEffect }, options?)
   autorun 的变种，对于如何追踪 observable 赋予了更细粒度的控制。 
   它接收两个函数参数，第一个(数据函数)是用来追踪并返回数据作为第二个函数(效果函数)的输入。
   不同于 autorun 的是当创建时效果函数不会直接运行，只有在数据表达式首次返回一个新值后才会运行。
 */
export function reaction<T>(
    expression: (r: IReactionPublic) => T,
    effect: (arg: T, r: IReactionPublic) => void,
    opts: IReactionOptions = EMPTY_OBJECT
): IReactionDisposer {
    if (process.env.NODE_ENV !== "production") {
        invariant(
            typeof expression === "function",
            "First argument to reaction should be a function"
        )
        invariant(typeof opts === "object", "Third argument of reactions should be an object")
    }
    const name = opts.name || "Reaction@" + getNextId()
    const effectAction = action(
        name,
        opts.onError ? wrapErrorHandler(opts.onError, effect) : effect
    )
    const runSync = !opts.scheduler && !opts.delay
    const scheduler = createSchedulerFromOptions(opts)

    let firstTime = true
    let isScheduled = false
    let value: T

    const equals = (opts as any).compareStructural
        ? comparer.structural
        : opts.equals || comparer.default

    const r = new Reaction(
        name,
        () => {
            if (firstTime || runSync) {
                reactionRunner()
            } else if (!isScheduled) {
                isScheduled = true
                scheduler!(reactionRunner)
            }
        },
        opts.onError,
        opts.requiresObservable
    )

    function reactionRunner() {
        isScheduled = false // Q: move into reaction runner?
        if (r.isDisposed) return
        let changed = false
        r.track(() => {
            const nextValue = expression(r)
            changed = firstTime || !equals(value, nextValue)
            value = nextValue
        })
        if (firstTime && opts.fireImmediately!) effectAction(value, r)
        if (!firstTime && (changed as boolean) === true) effectAction(value, r)
        if (firstTime) firstTime = false
    }

    //  r.schedule() --> runReactions() --> reactionScheduler(runReactionsHelper) 
    // --> reaction.runReaction() -->  this.onInvalidate()
    // 其中onInvalidate()就是new Reaction()的第二个参数: 如下所示，最终会调用reactionRunner()
    /**
     * 
     * () => {
            if (firstTime || runSync) {
                reactionRunner()
            } else if (!isScheduled) {
                isScheduled = true
                scheduler!(reactionRunner)
            }
        }
     */
    r.schedule()
    return r.getDisposer()
}

function wrapErrorHandler(errorHandler, baseFn) {
    return function() {
        try {
            return baseFn.apply(this, arguments)
        } catch (e) {
            errorHandler.call(this, e)
        }
    }
}
